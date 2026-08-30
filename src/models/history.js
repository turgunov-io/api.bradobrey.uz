const jwt = require('jsonwebtoken');
const { db } = require('../config/postgres');
const { enrichQueueEntriesWithBenefits } = require('../composable/enrichQueueBenefits');

const BARBER_HISTORY_ROLES = new Set(['barber', 'super-barber']);
const QUEUE_TIMESTAMP_KEYS = ['created_at', 'finished_at', 'started_at'];
const HISTORY_STATUSES = ['completed', 'cancelled', 'no_show', 'not_in_time'];

const toAmount = (value) => {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
};

const serviceIdsForEntry = (entry) => {
    const serviceIds = Array.isArray(entry?.service_ids)
        ? entry.service_ids.filter(Boolean)
        : [];

    if (serviceIds.length) return serviceIds;
    return entry?.service_id ? [entry.service_id] : [];
};

const hasExplicitTimezone = (value) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);

const normalizeTimestampAsUtc = (value) => {
    if (!value || typeof value !== 'string') return value ?? null;

    const normalized = value.trim().replace(' ', 'T');
    const valueWithTimezone = hasExplicitTimezone(normalized)
        ? normalized
        : `${normalized}Z`;
    const date = new Date(valueWithTimezone);

    return Number.isNaN(date.getTime()) ? value : date.toISOString();
};

const normalizeQueueEntryTimestamps = (entry) => {
    if (!entry || typeof entry !== 'object') return entry;

    return QUEUE_TIMESTAMP_KEYS.reduce((normalized, key) => {
        if (key in normalized) {
            normalized[key] = normalizeTimestampAsUtc(normalized[key]);
        }
        return normalized;
    }, { ...entry });
};

const normalizeQueueEntriesTimestamps = (entries) => (
    Array.isArray(entries) ? entries.map(normalizeQueueEntryTimestamps) : []
);

const enrichQueueEntriesWithAmounts = async (entries) => {
    const items = Array.isArray(entries) ? entries : [];
    if (!items.length) return items;

    const serviceIds = Array.from(
        new Set(items.flatMap(serviceIdsForEntry).filter(Boolean))
    );

    let priceByServiceId = new Map();

    if (serviceIds.length) {
        const { data, error } = await db
            .from('services')
            .select('id, base_price')
            .in('id', serviceIds);

        if (error) throw new Error(error.message);

        priceByServiceId = new Map(
            (data || []).map((service) => [
                String(service.id),
                toAmount(service.base_price),
            ])
        );
    }

    return items.map((entry) => {
        const originalAmount = serviceIdsForEntry(entry).reduce((sum, serviceId) => {
            return sum + (priceByServiceId.get(String(serviceId)) || 0);
        }, 0);
        const overrideAmount = toAmount(entry?.price_override);
        const hasOverride = overrideAmount > 0;

        return {
            ...entry,
            amount: hasOverride ? overrideAmount : originalAmount,
            amount_source: hasOverride ? 'price_override' : 'services',
            original_amount: originalAmount,
        };
    });
};

const isMissingPaymentsTableError = (error) => {
    const code = String(error?.code || '').trim();
    const message = String(error?.message || error?.details || '').toLowerCase();

    return code === '42P01'
        || code === 'PGRST205'
        || (message.includes('payments') && (
            message.includes('does not exist')
            || message.includes('not found')
            || message.includes('schema cache')
            || message.includes('could not find')
        ));
};

const enrichQueueEntriesWithPayments = async (entries) => {
    const items = Array.isArray(entries) ? entries : [];
    const entryIds = Array.from(new Set(items.map((entry) => entry?.id).filter(Boolean)));

    if (!entryIds.length) return items;

    const { data, error } = await db
        .from('payments')
        .select('queue_entry_id, amount, method, created_at')
        .in('queue_entry_id', entryIds);

    if (error) {
        if (isMissingPaymentsTableError(error)) {
            return items.map((entry) => ({ ...entry, payments: entry?.payments || [] }));
        }

        throw new Error(error.message);
    }

    const paymentsByEntryId = new Map();

    for (const payment of data || []) {
        const entryId = payment?.queue_entry_id;
        if (!entryId) continue;

        const current = paymentsByEntryId.get(entryId) || [];
        current.push({
            amount: payment.amount,
            created_at: payment.created_at,
            method: payment.method,
        });
        paymentsByEntryId.set(entryId, current);
    }

    return items.map((entry) => ({
        ...entry,
        payments: paymentsByEntryId.get(entry.id) || entry?.payments || [],
    }));
};

const prepareHistoryEntries = async (entries) => {
    const withAmounts = await enrichQueueEntriesWithAmounts(normalizeQueueEntriesTimestamps(entries || []));
    return enrichQueueEntriesWithPayments(withAmounts);
};

const getBearerToken = (req) => {
    const authHeader = req.headers.authorization || "";
    return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
};

const requireBarberHistoryAccess = (req, res) => {
    const token = getBearerToken(req);

    if (!token) {
        res.status(401).json({ error: "Authorization token is required" });
        return null;
    }

    let payload;
    try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (_err) {
        res.status(401).json({ error: "Invalid or expired token" });
        return null;
    }

    if (!BARBER_HISTORY_ROLES.has(payload?.role)) {
        res.status(403).json({ error: "Only barbers can view history" });
        return null;
    }

    return payload;
};

class History {
    async barber(req, res) {
        const payload = requireBarberHistoryAccess(req, res);
        if (!payload) return;

        const barberId = payload.sub || payload.id;

        const statusesParam = req.query?.status;
        const statusList = Array.isArray(statusesParam)
            ? statusesParam
            : statusesParam
                ? String(statusesParam).split(',').map((s) => s.trim()).filter(Boolean)
                : HISTORY_STATUSES;

        const allowedStatuses = HISTORY_STATUSES;
        const validStatuses = statusList.filter((s) => allowedStatuses.includes(s));
        const finalStatuses = validStatuses.length ? validStatuses : allowedStatuses;

        const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);

        const selectWithCertificate = `
                id,
                status,
                created_at,
                finished_at,
                service_id,
                service_ids,
                payment_method,
                certificate_id,
                price_override,
                price_override_reason,
                branch_id,
                barber_id,
                client:clients ( id, name, phone )
            `;

        const selectWithoutCertificate = `
                id,
                status,
                created_at,
                finished_at,
                service_id,
                service_ids,
                payment_method,
                price_override,
                price_override_reason,
                branch_id,
                barber_id,
                client:clients ( id, name, phone )
            `;

        let query = db
            .from('queue_entries')
            .select(selectWithCertificate, { count: 'exact' })
            .eq('barber_id', barberId)
            .in('status', finalStatuses)
            .order('finished_at', { ascending: false })
            .range(offset, offset + limit - 1);

        let { data, error, count } = await query;

        if (error && String(error.message || '').includes("Could not find the 'certificate_id' column")) {
            query = db
                .from('queue_entries')
                .select(selectWithoutCertificate, { count: 'exact' })
                .eq('barber_id', barberId)
                .in('status', finalStatuses)
                .order('finished_at', { ascending: false })
                .range(offset, offset + limit - 1);

            ({ data, error, count } = await query);
        }

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        let itemsWithAmounts;
        try {
            itemsWithAmounts = await prepareHistoryEntries(data || []);
        } catch (amountError) {
            return res.status(500).json({ error: amountError.message });
        }

        const enriched = await enrichQueueEntriesWithBenefits(itemsWithAmounts);

        return res.json({
            items: enriched,
            count: typeof count === 'number' ? count : (enriched ? enriched.length : 0),
            limit,
            offset,
            statuses: finalStatuses,
        });
    }

    async all(req, res) {
        const { filter } = req.query;
        const branchId = req.query.branch_id || req.query.branchId || req.query.id;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const statusesParam = req.query.status;
        const requestedStatuses = Array.isArray(statusesParam)
            ? statusesParam
            : statusesParam
                ? String(statusesParam).split(',').map((status) => status.trim()).filter(Boolean)
                : HISTORY_STATUSES;
        const statuses = requestedStatuses.filter((status) => HISTORY_STATUSES.includes(status));

        // all?filter=retention
        // all?filter=loyal
        // all?filter=all

        let query = db
            .from('queue_entries')
            .select(`
            id,
            status,
            created_at,
            finished_at,
            service_id,
            service_ids,
            payment_method,
            price_override,
            price_override_reason,
            branch_id,
            barber_id,
            client:clients ( id, name, phone, rank, completed_visits ),
            barber:barbers ( id, name )
        `, { count: 'exact' })
            .in('status', statuses.length ? statuses : HISTORY_STATUSES)
            .order('finished_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (branchId) {
            query = query.eq('branch_id', branchId);
        }

        const { data, error, count } = await query;

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        let items;
        try {
            items = await prepareHistoryEntries(data || []);
        } catch (amountError) {
            return res.status(500).json({ error: amountError.message });
        }

        const visits = {};

        for (const entry of items) {
            const clientId = entry.client?.id;
            if (!clientId) continue;

            if (!visits[clientId]) {
                visits[clientId] = 0;
            }

            visits[clientId]++;
        }

        let filtered = items;

        if (filter === "retention") {
            filtered = items.filter(e => visits[e.client?.id] >= 2);
        }

        if (filter === "loyal") {
            filtered = items.filter(e => visits[e.client?.id] >= 5);
        }

        return res.json({
            items: filtered,
            count: filter ? filtered.length : (typeof count === 'number' ? count : filtered.length),
            limit,
            offset,
        });
    }

    async branch(req, res) {
        const id = req.query.id;
        if (!id) return res.status(400).json({ error: "Branch ID is required!" });

        const { data, error } = await db
            .from('queue_entries')
            .select(`
                id,
                status,
                created_at,
                finished_at,
                service_id,
                service_ids,
                payment_method,
                price_override,
                price_override_reason,
                branch_id,
                barber_id,
                client:clients ( id, name, phone, rank, completed_visits ),
                barber:barbers ( id, name )
            `)
            .eq('branch_id', id)
            .in('status', HISTORY_STATUSES)
            .order('finished_at', { ascending: false });

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        try {
            return res.json({ data: await prepareHistoryEntries(data || []) })
        } catch (amountError) {
            return res.status(500).json({ error: amountError.message });
        }
    }
}

module.exports = new History();
