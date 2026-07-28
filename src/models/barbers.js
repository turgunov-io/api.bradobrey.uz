const { db } = require("../config/postgres");
const bcrypto = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { uploadBase64Image, uploadBufferImage } = require("../composable/uploadImage");
const { enrichQueueEntriesWithBenefits } = require("../composable/enrichQueueBenefits");
const { awardCashbackForCompletedQueueEntry } = require("../composable/cashback");
const { recordActivityEvent } = require("./verifix");

const shiftAutoOffTimers = new Map();
const breakTimers = new Map(); // barberId -> { timer, startedAt: Date, until: Date }
const callTimers = new Map(); // queueEntryId -> timer
const ADMIN_ROLES = new Set(['admin_network', 'admin_branch', 'admin', 'manager', 'super-manager', 'merchant']);
const BARBER_WORKSPACE_ROLES = new Set(['barber', 'super-barber']);
const LEGACY_LOGIN_ROLES = new Set([...ADMIN_ROLES, ...BARBER_WORKSPACE_ROLES]);
const EMPLOYEE_ROLES = new Set(['admin', 'manager', 'barber', 'super-barber', 'super-manager']);
const ACTIVE_QUEUE_STATUSES = ['waiting', 'called', 'swapped', 'in_progress'];
const REASSIGNABLE_QUEUE_STATUSES = ['waiting', 'called', 'swapped'];
const PAYMENT_PART_METHODS = new Set(['cash', 'card', 'certificate']);
const QUEUE_PAYMENT_METHODS = new Set(['cash', 'card', 'certificate', 'mixed']);

const CALL_LATE_MINUTES = 10;
const STALE_QUEUE_HOURS = 9;

async function endBreak(barberId, branchId, io) {
    // A break toggles `is_active` (see takeBreak/returnFromBreak), so ending a
    // break must restore `is_active`, not `is_on_shift`. Restoring the wrong
    // flag left barbers stuck at is_active=false, which silently excluded them
    // from reassignment candidates even while they looked active on shift.
    await db
        .from('barbers')
        .update({ is_active: true })
        .eq('id', barberId);
    if (io) {
        io.to(`branch:${branchId}`).emit('queue:update', {
            type: 'barber_status',
            barberId,
            is_active: true,
        });
    }
}
const MAX_AUTO_OFF_MINUTES = 8 * 60; // hard ceiling to avoid long-lived timers

const clampAutoOffMinutes = (minutes) => {
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return Math.min(minutes, MAX_AUTO_OFF_MINUTES);
};

const clearShiftTimer = (barberId) => {
    const timer = shiftAutoOffTimers.get(barberId);
    if (timer) {
        clearTimeout(timer);
        shiftAutoOffTimers.delete(barberId);
    }
};

const scheduleShiftAutoOff = (barberId, minutes) => {
    const clamped = clampAutoOffMinutes(minutes);
    if (!clamped) return null;

    clearShiftTimer(barberId);

    const ms = clamped * 60 * 1000;
    const timer = setTimeout(async () => {
        shiftAutoOffTimers.delete(barberId);
        try {
            await db
                .from('barbers')
                .update({ is_on_shift: false })
                .eq('id', barberId);
        } catch (e) {
            console.log(e.message);
        }
    }, ms);

    // Do not keep the event loop open for long timers
    if (typeof timer.unref === 'function') {
        timer.unref();
    }

    shiftAutoOffTimers.set(barberId, timer);
    return clamped;
};

const cleanupShiftTimers = () => {
    for (const timer of shiftAutoOffTimers.values()) {
        clearTimeout(timer);
    }
    shiftAutoOffTimers.clear();
};

const signUserToken = ({ id, login, role, branch_id = null }) => jwt.sign(
    {
        sub: id,
        login,
        role,
        branchId: branch_id,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
);

const isBarberWorkspaceRole = (role) => BARBER_WORKSPACE_ROLES.has(role);

const normalizeId = (value) => {
    const text = String(value || '').trim();
    return text || null;
};

const roundFinanceAmount = (value) => {
    const amount = Number(value);
    return Number.isFinite(amount) ? Math.round(amount) : 0;
};

const getCurrentFinancePeriod = () => {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
};

const periodRange = (period) => {
    const normalized = /^\d{4}-\d{2}$/.test(String(period || ''))
        ? String(period)
        : getCurrentFinancePeriod();
    const [yearText, monthText] = normalized.split('-');
    const year = Number(yearText);
    const monthIndex = Number(monthText) - 1;

    return {
        from: new Date(Date.UTC(year, monthIndex, 1)).toISOString(),
        period: normalized,
        to: new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString(),
    };
};

const isMissingFinanceSnapshotTable = (error) => {
    const code = String(error?.code || '').trim();
    const message = [
        error?.message,
        error?.details,
        error?.hint,
    ].filter(Boolean).join(' ');

    return code === '42P01'
        || code === 'PGRST205'
        || (
            /finance_snapshots/i.test(message)
            && /does not exist|not found|schema cache/i.test(message)
        );
};

const financeNumber = (value) => {
    const amount = Number(value);
    return Number.isFinite(amount) ? Math.max(0, amount) : 0;
};

const normalizeFinanceDraft = (value) => {
    const source = value && typeof value === 'object' ? value : {};

    return {
        advances: financeNumber(source.advances),
        bonus_profit_percent: financeNumber(source.bonus_profit_percent),
        penalty: financeNumber(source.penalty),
        profit: financeNumber(source.profit),
        profit_percent: financeNumber(source.profit_percent),
        salary: financeNumber(source.salary),
    };
};

const commissionForFinance = ({ goal, profit, profitPercent, bonusProfitPercent }) => {
    const normalizedProfit = financeNumber(profit);
    const normalizedGoal = financeNumber(goal);
    const basePercent = financeNumber(profitPercent);
    const bonusPercent = bonusProfitPercent > 0 ? financeNumber(bonusProfitPercent) : basePercent;
    const profitToGoal = normalizedGoal > 0 ? Math.min(normalizedProfit, normalizedGoal) : 0;
    const profitAboveGoal = Math.max(0, normalizedProfit - profitToGoal);

    return roundFinanceAmount(
        (profitToGoal * basePercent) / 100
        + (profitAboveGoal * bonusPercent) / 100
    );
};

const getFinanceSnapshotDraft = async ({ branchId, barberId, period }) => {
    if (!branchId || !barberId) {
        return normalizeFinanceDraft(null);
    }

    const { data, error } = await db
        .from('finance_snapshots')
        .select('payload')
        .eq('branch_id', branchId)
        .eq('period', period)
        .limit(1)
        .maybeSingle();

    if (error) {
        if (isMissingFinanceSnapshotTable(error)) {
            return normalizeFinanceDraft(null);
        }
        throw new Error(error.message);
    }

    const employees = data?.payload?.employees && typeof data.payload.employees === 'object'
        ? data.payload.employees
        : {};

    return normalizeFinanceDraft(employees[barberId]);
};

const authenticateBarberWorkspace = (req, res, forbiddenMessage) => {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
        res.status(401).json({ error: "Authorization token is required" });
        return null;
    }

    let payload;
    try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        res.status(401).json({ error: "Invalid or expired token" });
        return null;
    }

    if (!isBarberWorkspaceRole(payload.role)) {
        res.status(403).json({ error: forbiddenMessage });
        return null;
    }

    const barberId = payload.sub || payload.id;
    if (!barberId) {
        res.status(401).json({ error: "Invalid token payload" });
        return null;
    }

    return { barberId, payload };
};

const isMissingRelationError = (error, relation) => {
    const message = String(error?.message || error?.details || '').toLowerCase();
    return Boolean(error) && message.includes(relation.toLowerCase()) && (
        message.includes('does not exist') ||
        message.includes('could not find') ||
        message.includes('schema cache')
    );
};

const normalizeText = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const text = String(value).trim();
    return text || null;
};

const toArray = (value) => {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
};

const normalizePermissions = (value) => Array.from(
    new Set(
        toArray(value)
            .flatMap((item) => {
                if (typeof item !== 'string') return [item];
                if (!item.includes(',')) return [item];
                return item.split(',');
            })
            .map((item) => String(item || '').trim())
            .filter(Boolean)
    )
);

const syncUserPermissions = async (userId, permissions) => {
    const deleteResult = await db
        .from('user_permissions')
        .delete()
        .eq('user_id', userId);

    if (deleteResult.error) {
        if (isMissingRelationError(deleteResult.error, 'user_permissions')) return null;
        throw new Error(deleteResult.error.message);
    }

    const rows = normalizePermissions(permissions).map((permission) => ({
        permission,
        user_id: userId,
    }));

    if (!rows.length) return null;

    const insertResult = await db.from('user_permissions').insert(rows);
    if (insertResult.error) {
        if (isMissingRelationError(insertResult.error, 'user_permissions')) return null;
        throw new Error(insertResult.error.message);
    }

    return null;
};

const fetchPermissionsByUserIds = async (userIds) => {
    if (!userIds.length) return new Map();

    const { data, error } = await db
        .from('user_permissions')
        .select('user_id, permission')
        .in('user_id', userIds);

    if (error) {
        if (isMissingRelationError(error, 'user_permissions')) return new Map();
        throw new Error(error.message);
    }

    const map = new Map();
    for (const row of data || []) {
        const key = String(row.user_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row.permission);
    }

    return map;
};

const uploadEmployeePhoto = async (req, userId) => {
    if (req.file) {
        const { data, error } = await uploadBufferImage(
            req.file.buffer,
            req.file.mimetype || 'image/png',
            userId
        );

        if (error) throw new Error(error.message || 'Failed to upload image');
        return data?.publicUrl || null;
    }

    if (req.body?.image_base64) {
        const { data, error } = await uploadBase64Image(
            req.body.image_base64,
            req.body.content_type,
            userId
        );

        if (error) throw new Error(error.message || 'Failed to upload image');
        return data?.publicUrl || null;
    }

    return undefined;
};

const employeeItem = ({ user, barber, permissions = [] }) => ({
    branch_id: barber?.branch_id || user.branch_id || null,
    id: user.id,
    is_authorized: barber?.is_authorized ?? null,
    is_on_shift: barber?.is_on_shift ?? null,
    login: user.login || null,
    name: barber?.name || user.login || null,
    permissions,
    photo_url: barber?.photo_url || null,
    phone: barber?.phone || null,
    role: user.role || null,
    specialization: barber?.specialization || null,
});

const loadEmployeeDirectory = async ({ branchId, role } = {}) => {
    let query = db
        .from('users')
        .select('id, login, role, branch_id', { count: 'exact' })
        .in('role', Array.from(EMPLOYEE_ROLES));

    if (branchId) query = query.eq('branch_id', branchId);
    if (role && EMPLOYEE_ROLES.has(role)) query = query.eq('role', role);

    const { data: users, error: usersError, count } = await query
        .order('login', { ascending: true });

    if (usersError) throw new Error(usersError.message);

    const userIds = (users || []).map((user) => user.id).filter(Boolean);
    const [barbersResult, permissionsByUser] = await Promise.all([
        userIds.length
            ? db
                .from('barbers')
                .select('id, name, branch_id, photo_url, is_authorized, is_on_shift, specialization, phone')
                .in('id', userIds)
            : Promise.resolve({ data: [], error: null }),
        fetchPermissionsByUserIds(userIds),
    ]);

    if (barbersResult.error) throw new Error(barbersResult.error.message);

    const barbersById = new Map((barbersResult.data || []).map((barber) => [String(barber.id), barber]));
    const items = (users || []).map((user) => employeeItem({
        barber: barbersById.get(String(user.id)) || null,
        permissions: permissionsByUser.get(String(user.id)) || [],
        user,
    }));

    return { items, total: count ?? items.length };
};

const clearCallTimer = (entryId) => {
    const timer = callTimers.get(entryId);
    if (timer) {
        clearTimeout(timer);
        callTimers.delete(entryId);
    }
};

const markEntriesNoShow = async ({ barberId, branchId, cutoffIso }) => {
    const query = db
        .from('queue_entries')
        .update({ status: 'no_show', finished_at: new Date().toISOString() })
        .lte('created_at', cutoffIso)
        .in('status', ['waiting', 'called', 'swapped']);

    if (barberId) query.eq('barber_id', barberId);
    if (branchId) query.eq('branch_id', branchId);

    const { data, error } = await query.select('id');
    if (!error && Array.isArray(data)) {
        data.forEach((row) => clearCallTimer(row.id));
    }
    return { data, error };
};

const swapCalledEntry = async (entry) => {
    const { id, barber_id, branch_id, created_at } = entry || {};
    if (!id || !barber_id || !created_at) return null;

    const { data: nextEntry, error: nextError } = await db
        .from('queue_entries')
        .select('id, created_at')
        .eq('barber_id', barber_id)
        .eq('branch_id', branch_id)
        .in('status', ['waiting', 'swapped'])
        .gt('created_at', created_at)
        .neq('id', id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

    if (nextError) throw new Error(nextError.message);

    const updatePayload = {
        status: 'waiting',
        swapped_flag: true,
        started_at: null,
    };

    if (nextEntry) {
        const nextTs = new Date(nextEntry.created_at).getTime();
        updatePayload.created_at = new Date(nextTs + 1).toISOString();
    } else {
        updatePayload.created_at = new Date().toISOString();
    }

    const { data: updated, error: updateError } = await db
        .from('queue_entries')
        .update(updatePayload)
        .eq('id', id)
        .select('id, status, swapped_flag, created_at, branch_id, barber_id')
        .maybeSingle();

    if (updateError) throw new Error(updateError.message);
    return updated;
};

const markNoShow = async (entryId) => {
    const { data, error } = await db
        .from('queue_entries')
        .update({ status: 'no_show', finished_at: new Date().toISOString() })
        .eq('id', entryId)
        .select('id, branch_id, barber_id, status')
        .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
};

const serviceIdsForEntry = (entry) => {
    const serviceIds = Array.isArray(entry?.service_ids)
        ? entry.service_ids.filter(Boolean)
        : [];

    if (serviceIds.length) return serviceIds;
    return entry?.service_id ? [entry.service_id] : [];
};

const roundMoneyAmount = (value) => {
    const amount = Number(value);
    return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
};

const hasExplicitAmount = (value) => (
    value !== undefined
    && value !== null
    && String(value).trim() !== ''
);

const getQueueEntryAmount = async (entry) => {
    if (hasExplicitAmount(entry?.price_override)) {
        return roundMoneyAmount(entry.price_override);
    }

    const serviceIds = serviceIdsForEntry(entry);

    if (!serviceIds.length) {
        return 0;
    }

    const { data, error } = await db
        .from('services')
        .select('id, base_price')
        .in('id', serviceIds);

    if (error) {
        throw new Error(error.message);
    }

    return roundMoneyAmount((data || []).reduce((sum, service) => {
        return sum + roundMoneyAmount(service?.base_price);
    }, 0));
};

const normalizePaymentMethod = (value) => {
    const method = String(value || '').trim().toLowerCase();
    return method || null;
};

const normalizePaymentParts = (value) => {
    if (value === undefined || value === null) {
        return [];
    }

    if (!Array.isArray(value)) {
        const error = new Error('payments must be an array');
        error.statusCode = 400;
        throw error;
    }

    const payments = value
        .map((item) => ({
            amount: roundMoneyAmount(item?.amount),
            method: normalizePaymentMethod(item?.method),
        }))
        .filter((item) => item.amount > 0);

    for (const item of payments) {
        if (!PAYMENT_PART_METHODS.has(item.method)) {
            const error = new Error('payment method must be cash, card, or certificate');
            error.statusCode = 400;
            throw error;
        }
    }

    if (payments.some((item) => item.method === 'certificate') && payments.length > 1) {
        const error = new Error('certificate payment cannot be mixed with other methods');
        error.statusCode = 400;
        throw error;
    }

    return payments;
};

const getFinalPaymentMethod = ({ currentMethod, paymentMethod, payments }) => {
    if (payments.length > 1) {
        return 'mixed';
    }

    if (payments.length === 1) {
        return payments[0].method;
    }

    const normalized = normalizePaymentMethod(paymentMethod || currentMethod);

    if (!normalized) {
        return null;
    }

    if (!QUEUE_PAYMENT_METHODS.has(normalized)) {
        const error = new Error('payment_method must be cash, card, certificate, or mixed');
        error.statusCode = 400;
        throw error;
    }

    return normalized;
};

const replaceQueueEntryPayments = async ({ queueEntryId, payments }) => {
    if (!payments.length) {
        return [];
    }

    const { error: deleteError } = await db
        .from('payments')
        .delete()
        .eq('queue_entry_id', queueEntryId);

    if (deleteError) {
        throw new Error(deleteError.message);
    }

    const { data, error } = await db
        .from('payments')
        .insert(payments.map((payment) => ({
            amount: payment.amount,
            method: payment.method,
            queue_entry_id: queueEntryId,
        })))
        .select('id, queue_entry_id, amount, method, created_at');

    if (error) {
        throw new Error(error.message);
    }

    return data || [];
};

const isMissingPriceOverrideColumn = (error) => {
    const message = String(error?.message || error?.details || '').trim();
    return /price_override/i.test(message) && /could not find|does not exist|schema cache/i.test(message);
};

const completedRevenueQuery = ({ barberId, branchId, from, to, select }) => {
    let query = db
        .from('queue_entries')
        .select(select)
        .eq('barber_id', barberId)
        .eq('status', 'completed')
        .gte('finished_at', from)
        .lt('finished_at', to);

    if (branchId) {
        query = query.eq('branch_id', branchId);
    }

    return query;
};

const getCompletedQueueRevenue = async ({ barberId, branchId, from, to }) => {
    if (!barberId || !from || !to) return 0;

    let { data: entries, error } = await completedRevenueQuery({
        barberId,
        branchId,
        from,
        select: 'id, service_id, service_ids, price_override',
        to,
    });

    if (error && isMissingPriceOverrideColumn(error)) {
        ({ data: entries, error } = await completedRevenueQuery({
            barberId,
            branchId,
            from,
            select: 'id, service_id, service_ids',
            to,
        }));
    }

    if (error) throw new Error(error.message);
    if (!Array.isArray(entries) || !entries.length) return 0;

    const serviceIds = Array.from(
        new Set(entries.flatMap(serviceIdsForEntry).filter(Boolean))
    );
    let pricesByServiceId = new Map();

    if (serviceIds.length) {
        const { data: services, error: servicesError } = await db
            .from('services')
            .select('id, base_price')
            .in('id', serviceIds);

        if (servicesError) throw new Error(servicesError.message);

        pricesByServiceId = new Map(
            (services || []).map((service) => [
                String(service.id),
                financeNumber(service.base_price),
            ])
        );
    }

    return entries.reduce((sum, entry) => {
        const overrideAmount = financeNumber(entry?.price_override);

        if (overrideAmount > 0) {
            return sum + overrideAmount;
        }

        const servicesTotal = serviceIdsForEntry(entry).reduce((entrySum, serviceId) => {
            return entrySum + (pricesByServiceId.get(String(serviceId)) || 0);
        }, 0);

        return sum + servicesTotal;
    }, 0);
};

const getBarberProfileFinance = async ({ barberId, branchId, period }) => {
    const range = periodRange(period);
    const [draft, completedRevenue] = await Promise.all([
        getFinanceSnapshotDraft({ branchId, barberId, period: range.period }),
        getCompletedQueueRevenue({
            barberId,
            branchId,
            from: range.from,
            to: range.to,
        }),
    ]);
    const totalEarned = draft.profit > 0 ? draft.profit : completedRevenue;
    const commission = commissionForFinance({
        bonusProfitPercent: draft.bonus_profit_percent,
        goal: draft.salary,
        profit: totalEarned,
        profitPercent: draft.profit_percent,
    });

    return {
        advance: roundFinanceAmount(draft.advances),
        bonus_profit_percent: draft.bonus_profit_percent,
        commission,
        goal: roundFinanceAmount(draft.salary),
        payout: roundFinanceAmount(commission - draft.advances - draft.penalty),
        penalty: roundFinanceAmount(draft.penalty),
        period: range.period,
        profit_percent: draft.profit_percent,
        total_earned: roundFinanceAmount(totalEarned),
    };
};

const isStaleActiveEntry = (entry, cutoffIso) => {
    if (!entry?.created_at || !REASSIGNABLE_QUEUE_STATUSES.includes(entry.status)) return false;

    const createdAt = new Date(entry.created_at).getTime();
    const cutoffAt = new Date(cutoffIso).getTime();

    return Number.isFinite(createdAt) && Number.isFinite(cutoffAt) && createdAt < cutoffAt;
};

const getBranchBarberAvailability = async ({ branchId, excludeBarberId = null, excludeEntryId = null, requireOnShift = true }) => {
    // The barbers list and the active queue only share the branch id, so fetch
    // them concurrently instead of chaining awaits. Cuts a round-trip against a
    // remote database, which dominates latency when the API runs far from it.
    let queueQuery = db
        .from('queue_entries')
        .select('id, barber_id, status, service_id, service_ids')
        .eq('branch_id', branchId)
        .in('status', ACTIVE_QUEUE_STATUSES);

    if (excludeEntryId) {
        queueQuery = queueQuery.neq('id', excludeEntryId);
    }

    const [
        { data: barbers, error: barbersError },
        { data: queues, error: queuesError },
    ] = await Promise.all([
        db
            .from('barbers')
            .select('id, name, branch_id, photo_url, is_authorized, is_on_shift, is_active')
            .eq('branch_id', branchId),
        queueQuery,
    ]);

    if (barbersError) throw new Error(barbersError.message);
    if (queuesError) throw new Error(queuesError.message);

    const barberIds = (barbers || []).map((barber) => barber.id).filter(Boolean);
    const allServiceIds = Array.from(
        new Set((queues || []).flatMap(serviceIdsForEntry).filter(Boolean))
    );

    // users (role gate) depends on barberIds; services (durations) depends on
    // the queue's service ids — independent of each other, so run in parallel.
    const [usersResult, servicesResult] = await Promise.all([
        barberIds.length
            ? db
                .from('users')
                .select('id, role')
                .in('id', barberIds)
                .in('role', Array.from(BARBER_WORKSPACE_ROLES))
            : Promise.resolve({ data: [], error: null }),
        allServiceIds.length
            ? db
                .from('services')
                .select('id, duration_minutes')
                .in('id', allServiceIds)
            : Promise.resolve({ data: [], error: null }),
    ]);

    if (usersResult.error) throw new Error(usersResult.error.message);
    if (servicesResult.error) throw new Error(servicesResult.error.message);

    const allowedBarberIds = new Set((usersResult.data || []).map((user) => user.id));
    const durationByServiceId = new Map(
        (servicesResult.data || []).map((service) => [
            String(service.id),
            Number(service.duration_minutes || 0),
        ])
    );

    const candidates = (barbers || [])
        .filter((barber) => allowedBarberIds.has(barber.id))
        .filter((barber) => !excludeBarberId || barber.id !== excludeBarberId)
        // Operational availability must match how the kiosk lists/books barbers
        // (role + is_active + is_on_shift). is_authorized is a merchant-approval
        // flag the kiosk ignores, so requiring it here silently rejected barbers
        // that the app shows as valid reassignment targets.
        .filter((barber) => barber.is_active !== false)
        .filter((barber) => !requireOnShift || barber.is_on_shift === true);

    const candidateIds = new Set(candidates.map((barber) => barber.id));
    const statsByBarber = new Map();

    for (const entry of queues || []) {
        const barberId = entry?.barber_id;
        if (!candidateIds.has(barberId)) continue;

        const currentStats = statsByBarber.get(barberId) || {
            current_clients: 0,
            estimated_waiting_time: 0,
        };

        currentStats.current_clients += 1;
        currentStats.estimated_waiting_time += serviceIdsForEntry(entry).reduce((sum, serviceId) => {
            return sum + (durationByServiceId.get(String(serviceId)) || 0);
        }, 0);

        statsByBarber.set(barberId, currentStats);
    }

    return candidates
        .map((barber) => {
            const stats = statsByBarber.get(barber.id) || {
                current_clients: 0,
                estimated_waiting_time: 0,
            };

            return {
                id: barber.id,
                name: barber.name,
                photo: barber.photo_url || null,
                branch_id: barber.branch_id,
                is_active: barber.is_active ?? null,
                is_on_shift: barber.is_on_shift ?? null,
                current_clients: stats.current_clients,
                estimated_waiting_time: stats.estimated_waiting_time,
            };
        })
        .sort((left, right) => (
            left.estimated_waiting_time - right.estimated_waiting_time
            || left.current_clients - right.current_clients
            || String(left.name || '').localeCompare(String(right.name || ''), 'ru')
        ));
};

const getQueueTailCreatedAt = async ({ branchId, barberId }) => {
    const { data: tailEntry, error } = await db
        .from('queue_entries')
        .select('id, created_at')
        .eq('branch_id', branchId)
        .eq('barber_id', barberId)
        .in('status', ACTIVE_QUEUE_STATUSES)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw new Error(error.message);

    const tailTime = tailEntry?.created_at ? new Date(tailEntry.created_at).getTime() : NaN;
    const nextTime = Number.isFinite(tailTime)
        ? Math.max(Date.now(), tailTime + 1)
        : Date.now();

    return new Date(nextTime).toISOString();
};

const scheduleCallFollowUp = (entry, io) => {
    if (!entry?.id) return;
    clearCallTimer(entry.id);

    const timer = setTimeout(async () => {
        callTimers.delete(entry.id);
        try {
            const { data: fresh, error } = await db
                .from('queue_entries')
                .select('id, status, swapped_flag, created_at, branch_id, barber_id')
                .eq('id', entry.id)
                .maybeSingle();

            if (error || !fresh || fresh.status !== 'called') return;

            const isSecondCall = fresh.swapped_flag === true;
            if (isSecondCall) {
                await markNoShow(fresh.id);
            } else {
                await swapCalledEntry(fresh);
            }

            if (io) {
                io.to(`branch:${fresh.branch_id}`).emit('queue:update', {
                    type: 'queue_changed',
                    barberId: fresh.barber_id,
                });
            }
        } catch (e) {
            console.error('call follow-up failed:', e.message);
        }
    }, CALL_LATE_MINUTES * 60 * 1000);

    if (typeof timer.unref === 'function') timer.unref();
    callTimers.set(entry.id, timer);
};

const emitCallEvent = (io, entry) => {
    if (!io || !entry?.branch_id) return;
    io.to(`branch:${entry.branch_id}`).emit('queue:update', {
        type: 'call',
        entryId: entry.id,
        barberId: entry.barber_id,
        branchId: entry.branch_id,
        clientId: entry.client?.id || entry.client_id || null,
        clientName: entry.client?.name || entry.client_name || null,
    });
};

const logVerifixEvent = async ({ actorId, actorRole, barberId, branchId, eventType, io, metadata, source = 'barber_kiosk' }) => {
    try {
        await recordActivityEvent({
            actorId,
            actorRole,
            barberId,
            branchId,
            eventType,
            io,
            metadata,
            source,
        });
    } catch (error) {
        console.error(`verifix ${eventType} log failed:`, error.message);
    }
};

process.on('SIGTERM', cleanupShiftTimers);
process.on('SIGINT', cleanupShiftTimers);

class Barbers {
    async list(req, res) {
        try {
            const mode = String(req.query?.mode || '').trim();
            if (mode && mode !== 'employees') {
                return res.status(400).json({ error: 'Unsupported barbers list mode' });
            }

            const branchId = normalizeText(req.query?.branch_id);
            const role = normalizeText(req.query?.role);

            const result = await loadEmployeeDirectory({ branchId, role });
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ error: error.message || 'Failed to load employees' });
        }
    }

    async updateEmployee(req, res) {
        try {
            const { id } = req.params || {};
            if (!id) return res.status(400).json({ error: 'Employee id is required' });

            const {
                branch_id,
                login,
                name,
                password,
                permissions,
                phone,
                role,
                specialization,
            } = req.body || {};

            const normalizedLogin = normalizeText(login);
            const normalizedName = normalizeText(name);
            const normalizedRole = normalizeText(role);
            const normalizedBranchId = normalizeText(branch_id);

            if (!normalizedLogin) return res.status(400).json({ error: 'login is required' });
            if (!normalizedName) return res.status(400).json({ error: 'name is required' });
            if (!normalizedBranchId) return res.status(400).json({ error: 'branch_id is required' });
            if (!EMPLOYEE_ROLES.has(normalizedRole)) return res.status(400).json({ error: 'role is invalid' });
            if (password !== undefined && String(password || '').trim() && String(password).length < 6) {
                return res.status(400).json({ error: 'password must be at least 6 characters' });
            }

            const userUpdate = {
                branch_id: normalizedBranchId,
                login: normalizedLogin,
                role: normalizedRole,
            };

            if (password !== undefined && String(password || '').trim()) {
                userUpdate.password_hash = bcrypto.hashSync(password, 10);
            }

            const { data: user, error: userError } = await db
                .from('users')
                .update(userUpdate)
                .eq('id', id)
                .select('id, login, role, branch_id')
                .maybeSingle();

            if (userError) {
                const status = userError.code === '23505' ? 409 : 500;
                return res.status(status).json({ error: userError.code === '23505' ? 'login already taken' : userError.message });
            }
            if (!user) return res.status(404).json({ error: 'Employee not found' });

            const uploadedPhotoUrl = await uploadEmployeePhoto(req, id);
            const photoUrl = uploadedPhotoUrl !== undefined
                ? uploadedPhotoUrl
                : req.body && Object.prototype.hasOwnProperty.call(req.body, 'photo_url')
                    ? normalizeText(req.body.photo_url)
                    : undefined;

            const barberPayload = {
                branch_id: normalizedBranchId,
                id,
                name: normalizedName,
                phone: normalizeText(phone) ?? null,
                specialization: normalizeText(specialization) ?? null,
            };

            if (photoUrl !== undefined) barberPayload.photo_url = photoUrl;

            const { data: barber, error: barberError } = await db
                .from('barbers')
                .upsert(barberPayload, { onConflict: 'id' })
                .select('id, name, branch_id, phone, specialization, is_on_shift, is_authorized, photo_url')
                .maybeSingle();

            if (barberError) return res.status(500).json({ error: barberError.message });

            await syncUserPermissions(id, permissions);
            const permissionMap = await fetchPermissionsByUserIds([id]);
            const item = employeeItem({
                barber,
                permissions: permissionMap.get(String(id)) || [],
                user,
            });

            return res.json({ item, barber, user });
        } catch (error) {
            return res.status(500).json({ error: error.message || 'Failed to update employee' });
        }
    }

    async removeEmployee(req, res) {
        try {
            const { id } = req.params || {};
            if (!id) return res.status(400).json({ error: 'Employee id is required' });

            const { data: existing, error: existingError } = await db
                .from('users')
                .select('id')
                .eq('id', id)
                .maybeSingle();

            if (existingError) return res.status(500).json({ error: existingError.message });
            if (!existing) return res.status(404).json({ error: 'Employee not found' });

            const permissionDelete = await db
                .from('user_permissions')
                .delete()
                .eq('user_id', id);

            if (permissionDelete.error && !isMissingRelationError(permissionDelete.error, 'user_permissions')) {
                return res.status(500).json({ error: permissionDelete.error.message });
            }

            await db
                .from('barbers')
                .update({ is_authorized: false, is_on_shift: false })
                .eq('id', id);

            const { data, error } = await db
                .from('users')
                .delete()
                .eq('id', id)
                .select('id')
                .maybeSingle();

            if (error) return res.status(500).json({ error: error.message });
            return res.json({ deleted: true, id: data?.id || id });
        } catch (error) {
            return res.status(500).json({ error: error.message || 'Failed to delete employee' });
        }
    }

    async takeBreak(req, res) {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: "Authorization token is required" });
        }

        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        if (!isBarberWorkspaceRole(payload.role)) {
            return res.status(403).json({ error: 'Only barbers can take a break' });
        }

        const minutesRaw = req.body?.minutes ?? 15;
        const minutes = Number(minutesRaw);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) {
            return res.status(400).json({ error: 'minutes must be between 1 and 180' });
        }

        const barberId = payload.sub || payload.id;

        const { data: barber, error: barberError } = await db
            .from('barbers')
            .select('id, branch_id')
            .eq('id', barberId)
            .maybeSingle();

        if (barberError) {
            return res.status(500).json({ error: barberError.message });
        }
        if (!barber) {
            return res.status(404).json({ error: 'Barber not found' });
        }

        // if already on break and comes repeat request — end early
        if (breakTimers.has(barberId)) {
            const existing = breakTimers.get(barberId);
            clearTimeout(existing.timer);
            breakTimers.delete(barberId);
            const io = req.app.get('io');
            try {
                await endBreak(barberId, barber.branch_id, io);
                await logVerifixEvent({
                    actorId: barberId,
                    actorRole: payload.role,
                    barberId,
                    branchId: barber.branch_id,
                    eventType: 'break_end',
                    io,
                    metadata: { ended_early: true },
                });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
            return res.json({ status: 'ok', ended_early: true });
        }

        const { error: updateError } = await db
            .from('barbers')
            .update({ is_active: false })
            .eq('id', barberId);

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        const ms = minutes * 60 * 1000;
        const untilTs = new Date(Date.now() + ms);
        const io = req.app.get('io');

        const timer = setTimeout(async () => {
            breakTimers.delete(barberId);
            try {
                await endBreak(barberId, barber.branch_id, io);
                await logVerifixEvent({
                    barberId,
                    branchId: barber.branch_id,
                    eventType: 'break_end',
                    io,
                    metadata: { auto_return: true },
                    source: 'system',
                });
            } catch (e) {
                console.error(e.message);
            }
        }, ms);

        breakTimers.set(barberId, { timer, startedAt: new Date(), until: untilTs });

        if (io) {
            io.to(`branch:${barber.branch_id}`).emit('queue:update', {
                type: 'barber_status',
                barberId,
                is_active: false,
            });
        }

        await logVerifixEvent({
            actorId: barberId,
            actorRole: payload.role,
            barberId,
            branchId: barber.branch_id,
            eventType: 'break_start',
            io,
            metadata: { minutes },
        });

        return res.json({ status: 'ok', until: untilTs.toISOString() });
    }

    async returnFromBreak(req, res) {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: "Authorization token is required" });
        }

        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        if (!isBarberWorkspaceRole(payload.role)) {
            return res.status(403).json({ error: 'Only barbers can return from break' });
        }

        const barberId = payload.sub || payload.id;

        const { data: barber, error: barberError } = await db
            .from('barbers')
            .select('id, branch_id')
            .eq('id', barberId)
            .maybeSingle();

        if (barberError) {
            return res.status(500).json({ error: barberError.message });
        }
        if (!barber) {
            return res.status(404).json({ error: 'Barber not found' });
        }

        if (breakTimers.has(barberId)) {
            clearTimeout(breakTimers.get(barberId).timer);
            breakTimers.delete(barberId);
        }

        const { error: updateError } = await db
            .from('barbers')
            .update({ is_active: true })
            .eq('id', barberId);

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        const io = req.app.get('io');
        if (io) {
            io.to(`branch:${barber.branch_id}`).emit('queue:update', {
                type: 'barber_status',
                barberId,
                is_active: true,
            });
        }

        await logVerifixEvent({
            actorId: barberId,
            actorRole: payload.role,
            barberId,
            branchId: barber.branch_id,
            eventType: 'break_end',
            io,
            metadata: { manual_return: true },
        });

        return res.json({ status: 'ok' });
    }

    async login(req, res) {
        const {
            login, password, branch_id
        } = req.body || {};

        if (!login || !password) {
            return res.status(400).json({ error: 'Login and password are required' });
        }

        const { data: users, error: userError } = await db
            .from('users')
            .select('id, login, role, branch_id, password_hash')
            .eq('login', login)
            .in('role', Array.from(LEGACY_LOGIN_ROLES))
            .limit(1);

        if (userError) {
            return res.status(500).json({ error: 'Failed to verify credentials' });
        }

        const userData = Array.isArray(users) ? users[0] : null;
        if (!userData) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const passwordCheck = bcrypto.compareSync(password, userData.password_hash);
        if (!passwordCheck) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        if (ADMIN_ROLES.has(userData.role)) {
            const effectiveBranchId = userData.branch_id || null;
            const token = signUserToken({
                branch_id: effectiveBranchId,
                id: userData.id,
                login: userData.login,
                role: userData.role,
            });

            return res.json({
                token,
                user: {
                    id: userData.id,
                    login: userData.login,
                    role: userData.role,
                    branch_id: effectiveBranchId,
                },
            });
        }

        if (!branch_id) return res.status(400).json({ error: 'Branch ID is required' });

        await db
            .from('users')
            .update({ branch_id })
            .eq('id', userData.id);
        await db
            .from('barbers')
            .update({ branch_id, is_on_shift: true })
            .eq('id', userData.id);

        const token = signUserToken({
            branch_id,
            id: userData.id,
            login: userData.login,
            role: userData.role,
        });

        await logVerifixEvent({
            actorId: userData.id,
            actorRole: userData.role,
            barberId: userData.id,
            branchId: branch_id,
            eventType: 'login',
            io: req.app.get('io'),
            metadata: { login: userData.login },
        });

        return res.json({
            token,
            user: {
                id: userData.id,
                login: userData.login,
                role: userData.role,
                branch_id,
            },
        });
    }

    async adminLogin(req, res) {
        const { login, password } = req.body || {};

        if (!login || !password) {
            return res.status(400).json({ error: 'Login and password are required' });
        }

        const { data: users, error: userError } = await db
            .from('users')
            .select('id, login, role, branch_id, password_hash')
            .eq('login', login)
            .in('role', Array.from(ADMIN_ROLES))
            .limit(1);

        if (userError) {
            return res.status(500).json({ error: 'Failed to verify credentials' });
        }

        const adminUser = Array.isArray(users) ? users[0] : null;
        if (!adminUser) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const passwordCheck = bcrypto.compareSync(password, adminUser.password_hash);
        if (!passwordCheck) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const token = signUserToken({
            branch_id: adminUser.branch_id || null,
            id: adminUser.id,
            login: adminUser.login,
            role: adminUser.role,
        });

        return res.json({
            token,
            user: {
                id: adminUser.id,
                login: adminUser.login,
                role: adminUser.role,
                branch_id: adminUser.branch_id || null,
            },
        });
    }

    async register(req, res) {
        const {
            branch_id = null,
            login,
            name,
            password,
            permissions,
            phone,
            role = 'barber',
            specialization = null,
        } = req.body || {};

        if (!login || !password || !name || !branch_id) {
            return res.status(400).json({ error: 'login, password, name, and branch_id are required' });
        }

        const normalizedRole = normalizeText(role) || 'barber';
        if (!EMPLOYEE_ROLES.has(normalizedRole)) {
            return res.status(400).json({ error: 'role is invalid' });
        }

        if (String(password).length < 6) {
            return res.status(400).json({ error: 'password must be at least 6 characters' });
        }

        const { data: existing, error: existingError } = await db
            .from('users')
            .select('id')
            .eq('login', login)
            .maybeSingle();

        if (existingError) {
            return res.status(500).json({ error: existingError.message });
        }
        if (existing) {
            return res.status(409).json({ error: 'login already taken' });
        }

        const password_hash = bcrypto.hashSync(password, 10);

        const { data: userRow, error: userError } = await db
            .from('users')
            .insert({ login, password_hash, role: normalizedRole, branch_id })
            .select('id, login, role, branch_id')
            .maybeSingle();

        if (userError || !userRow) {
            return res.status(500).json({ error: userError?.message || 'failed to create user' });
        }

        let uploadedPhotoUrl;
        try {
            uploadedPhotoUrl = await uploadEmployeePhoto(req, userRow.id);
        } catch (error) {
            await db.from('users').delete().eq('id', userRow.id);
            return res.status(500).json({ error: error.message || 'Failed to upload image' });
        }

        const barberPayload = {
            branch_id,
            id: userRow.id,
            is_on_shift: false,
            name,
            phone: normalizeText(phone) ?? null,
            photo_url: uploadedPhotoUrl !== undefined ? uploadedPhotoUrl : normalizeText(req.body?.photo_url) ?? null,
            specialization: normalizeText(specialization) ?? null,
        };

        const { data: barberRow, error: barberError } = await db
            .from('barbers')
            .insert(barberPayload)
            .select('id, name, branch_id, phone, specialization, is_on_shift, is_authorized, photo_url')
            .maybeSingle();

        if (barberError || !barberRow) {
            await db.from('users').delete().eq('id', userRow.id);
            return res.status(500).json({ error: barberError?.message || 'failed to create barber' });
        }

        try {
            await syncUserPermissions(userRow.id, permissions);
        } catch (error) {
            await db.from('barbers').delete().eq('id', userRow.id);
            await db.from('users').delete().eq('id', userRow.id);
            return res.status(500).json({ error: error.message || 'failed to save permissions' });
        }

        const permissionMap = await fetchPermissionsByUserIds([userRow.id]);
        const item = employeeItem({
            barber: barberRow,
            permissions: permissionMap.get(String(userRow.id)) || [],
            user: userRow,
        });

        return res.status(201).json({
            user: userRow,
            barber: barberRow,
            item,
        });
    }

    async me(req, res) {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: "Authorization token is required" });
        }

        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        const userId = payload.sub || payload.id;

        const { data: user, error: userError } = await db
            .from('users')
            .select('id, login, role, branch_id')
            .eq('id', userId)
            .maybeSingle();

        if (userError) {
            return res.status(500).json({ error: userError.message });
        }

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        let barber = null;
        if (isBarberWorkspaceRole(user.role)) {
            const { data: barberData, error: barberError } = await db
                .from('barbers')
                .select('id, name, photo_url, branch_id, is_authorized, is_on_shift, is_active, specialization')
                .eq('id', user.id)
                .maybeSingle();

            if (barberError) {
                return res.status(500).json({ error: barberError.message });
            }
            if (!barberData) {
                return res.status(404).json({ error: 'Barber profile not found' });
            }

            const io = req.app.get('io');
            const breakInfo = breakTimers.get(user.id);
            // auto-finish break if timer elapsed (for safety)
            if (breakInfo && breakInfo.until <= new Date()) {
                clearTimeout(breakInfo.timer);
                breakTimers.delete(user.id);
                try {
                    await endBreak(user.id, barberData.branch_id, io);
                    barberData.is_active = true;
                } catch (e) {
                    // ignore, return current state
                }
            }
            const updatedBreak = breakTimers.get(user.id);
            const finance = await getBarberProfileFinance({
                barberId: user.id,
                branchId: barberData.branch_id || user.branch_id,
                period: req.query?.period,
            });

            barber = {
                ...barberData,
                break_started_at: updatedBreak?.startedAt ? updatedBreak.startedAt.toISOString() : null,
                break_until: updatedBreak?.until ? updatedBreak.until.toISOString() : null,
                finance,
            };
        }

        return res.json({ user, barber });
    }

    async myQueue(req, res) {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: "Authorization token is required" });
        }

        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        if (!isBarberWorkspaceRole(payload.role)) {
            return res.status(403).json({ error: 'Only barbers can view their queue' });
        }

        const barberId = payload.sub || payload.id;

        const cutoffIso = new Date(Date.now() - STALE_QUEUE_HOURS * 60 * 60 * 1000).toISOString();
        try {
            await markEntriesNoShow({ barberId, cutoffIso });
        } catch (e) {
            console.error('stale queue cleanup failed:', e.message);
        }

        let { data, error } = await db
            .from('queue_entries')
            .select(`
                id,
                status,
                swapped_flag,
                created_at,
                started_at,
                finished_at,
                service_id,
                service_ids,
                payment_method,
                certificate_id,
                branch_id,
                client:clients ( id, name, phone )
            `)
            .eq('barber_id', barberId)
            .in('status', ['waiting', 'called', 'in_progress'])
            .order('created_at', { ascending: true });

        if (error && String(error.message || '').includes("Could not find the 'certificate_id' column")) {
            ({ data, error } = await db
                .from('queue_entries')
                .select(`
                    id,
                    status,
                    swapped_flag,
                    created_at,
                    started_at,
                    finished_at,
                    service_id,
                    service_ids,
                    payment_method,
                    branch_id,
                    client:clients ( id, name, phone )
                `)
                .eq('barber_id', barberId)
                .in('status', ['waiting', 'called', 'in_progress'])
                .order('created_at', { ascending: true }));
        }

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        const filtered = (data || []).filter((entry) => {
            if (!entry?.created_at) return true;
            if (['waiting', 'called', 'swapped'].includes(entry.status)) {
                return new Date(entry.created_at) >= new Date(cutoffIso);
            }
            return true;
        });

        const enriched = await enrichQueueEntriesWithBenefits(filtered);

        return res.json({
            items: enriched,
            count: Array.isArray(enriched) ? enriched.length : 0,
        });
    }

    async getQueueById(req, res) {
        const { id } = req.params || {};

        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: "Authorization token is required" });
        }

        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        if (!isBarberWorkspaceRole(payload.role)) {
            return res.status(403).json({ error: 'Only barbers can view queue entries' });
        }

        const barberId = payload.sub || payload.id;

        let { data, error } = await db
            .from('queue_entries')
            .select(`
                id,
                status,
                created_at,
                finished_at,
                service_id,
                service_ids,
                payment_method,
                certificate_id,
                branch_id,
                client:clients ( id, name, phone )
            `)
            .eq('id', id)
            .eq('barber_id', barberId)
            .maybeSingle();

        if (error && String(error.message || '').includes("Could not find the 'certificate_id' column")) {
            ({ data, error } = await db
                .from('queue_entries')
                .select(`
                    id,
                    status,
                    created_at,
                    finished_at,
                    service_id,
                    service_ids,
                    payment_method,
                    branch_id,
                    client:clients ( id, name, phone )
                `)
                .eq('id', id)
                .eq('barber_id', barberId)
                .maybeSingle());
        }

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        if (!data) {
            return res.status(404).json({ error: 'Queue entry not found' });
        }

        const [enriched] = await enrichQueueEntriesWithBenefits([data]);
        const entry = enriched || data;

        if (entry.status === 'completed') {
            return res.status(209).json({ warning: "completed", data: entry });
        }

        return res.status(200).json(entry);
    }

    async updateQueue(req, res) {
        const { id } = req.params || {};
        const { status, payment_method, service_id, service_ids } = req.body || {};

        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: "Authorization token is required" });
        }

        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        if (!isBarberWorkspaceRole(payload.role)) {
            return res.status(403).json({ error: 'Only barbers can edit their queue entries' });
        }

        if (!id) {
            return res.status(400).json({ error: 'Queue entry id is required' });
        }

        const barberId = payload.sub || payload.id;

        const { data: entry, error: entryError } = await db
            .from('queue_entries')
            .select('id, barber_id, status, swapped_flag, branch_id, created_at')
            .eq('id', id)
            .eq('barber_id', barberId)
            .maybeSingle();

        if (entryError) {
            return res.status(500).json({ error: entryError.message });
        }
        if (!entry) {
            return res.status(404).json({ error: 'Queue entry not found' });
        }

        const allowedStatuses = [
            'waiting',
            'called',
            'in_progress',
            'completed',
            'cancelled',
            'rejected',
            'swapped',
            'no_show',
            'not_in_time',
        ];

        const updatePayload = {};

        if (status !== undefined) {
            if (!allowedStatuses.includes(status)) {
                return res.status(400).json({ error: 'Invalid status value' });
            }
            updatePayload.status = status;
            if (['completed', 'cancelled', 'rejected', 'no_show', 'not_in_time'].includes(status)) {
                updatePayload.finished_at = new Date().toISOString();
            }
        }

        if (payment_method !== undefined) {
            updatePayload.payment_method = payment_method;
        }

        if (service_id !== undefined) {
            updatePayload.service_id = service_id || null;
        }

        if (Array.isArray(service_ids)) {
            updatePayload.service_ids = service_ids;
            if (!updatePayload.service_id && service_ids.length) {
                updatePayload.service_id = service_ids[0];
            }
        }

        if (Object.keys(updatePayload).length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        const { data: updated, error: updateError } = await db
            .from('queue_entries')
            .update(updatePayload)
            .eq('id', id)
            .eq('barber_id', barberId)
            .select('id, status, swapped_flag, created_at, finished_at, service_id, service_ids, payment_method, branch_id, barber_id, client_id, price_override, price_override_reason, client:clients ( id, name )')
            .maybeSingle();

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        const io = req.app.get('io');
        if (status !== undefined) {
            if (status === 'called') {
                scheduleCallFollowUp(updated, io);
                emitCallEvent(io, updated);
            } else {
                clearCallTimer(id);
            }
        }

        let cashback = null;
        if (status === 'completed' && entry.status !== 'completed') {
            cashback = await awardCashbackForCompletedQueueEntry(updated);
        }

        return res.json({ entry: updated, cashback });
    }

    async queueReassignOptions(req, res) {
        const { id } = req.params || {};
        const auth = authenticateBarberWorkspace(req, res, 'Only barbers can view queue reassign options');

        if (!auth) return;
        if (!id) {
            return res.status(400).json({ error: 'Queue entry id is required' });
        }

        const branchId = normalizeId(auth.payload?.branchId);

        // Branch-scoped (matches reassignQueue): any barber in the same branch
        // may view reassign options, not just the entry's current owner.
        const entryQuery = db
            .from('queue_entries')
            .select('id, barber_id, status, branch_id, created_at')
            .eq('id', id);
        if (branchId) {
            entryQuery.eq('branch_id', branchId);
        } else {
            entryQuery.eq('barber_id', auth.barberId);
        }

        const { data: entry, error: entryError } = await entryQuery.maybeSingle();

        if (entryError) {
            return res.status(500).json({ error: entryError.message });
        }
        if (!entry) {
            return res.status(404).json({ error: 'Queue entry not found' });
        }
        if (!REASSIGNABLE_QUEUE_STATUSES.includes(entry.status)) {
            return res.status(400).json({ error: 'Only waiting or called queue entries can be reassigned' });
        }

        try {
            const cutoffIso = new Date(Date.now() - STALE_QUEUE_HOURS * 60 * 60 * 1000).toISOString();
            if (isStaleActiveEntry(entry, cutoffIso)) {
                await markEntriesNoShow({ branchId: entry.branch_id, cutoffIso });
                return res.status(400).json({ error: 'Queue entry is stale and cannot be reassigned' });
            }

            await markEntriesNoShow({ branchId: entry.branch_id, cutoffIso });

            const candidates = await getBranchBarberAvailability({
                branchId: entry.branch_id,
                excludeBarberId: entry.barber_id,
                excludeEntryId: id,
                requireOnShift: true,
            });

            return res.json({
                candidates,
                recommended_barber_id: candidates[0]?.id || null,
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    async reassignQueue(req, res) {
        const { id } = req.params || {};
        const targetBarberId = normalizeId(req.body?.barber_id);
        const auth = authenticateBarberWorkspace(req, res, 'Only barbers can reassign queue entries');

        if (!auth) return;
        if (!id) {
            return res.status(400).json({ error: 'Queue entry id is required' });
        }

        const branchId = normalizeId(auth.payload?.branchId);

        // Branch-scoped: any barber in the same branch may reassign an entry,
        // not just its current owner. Fall back to owner-only for legacy tokens
        // that carry no branch claim.
        const entryQuery = db
            .from('queue_entries')
            .select('id, barber_id, status, branch_id, created_at')
            .eq('id', id);
        if (branchId) {
            entryQuery.eq('branch_id', branchId);
        } else {
            entryQuery.eq('barber_id', auth.barberId);
        }

        const { data: entry, error: entryError } = await entryQuery.maybeSingle();

        if (entryError) {
            return res.status(500).json({ error: entryError.message });
        }
        if (!entry) {
            return res.status(404).json({ error: 'Queue entry not found' });
        }
        if (!REASSIGNABLE_QUEUE_STATUSES.includes(entry.status)) {
            return res.status(400).json({ error: 'Only waiting or called queue entries can be reassigned' });
        }
        if (targetBarberId && targetBarberId === entry.barber_id) {
            return res.status(400).json({ error: 'Queue entry already belongs to this barber' });
        }

        try {
            const cutoffIso = new Date(Date.now() - STALE_QUEUE_HOURS * 60 * 60 * 1000).toISOString();
            if (isStaleActiveEntry(entry, cutoffIso)) {
                await markEntriesNoShow({ branchId: entry.branch_id, cutoffIso });
                return res.status(400).json({ error: 'Queue entry is stale and cannot be reassigned' });
            }

            await markEntriesNoShow({ branchId: entry.branch_id, cutoffIso });

            const candidates = await getBranchBarberAvailability({
                branchId: entry.branch_id,
                excludeBarberId: entry.barber_id,
                excludeEntryId: id,
                requireOnShift: true,
            });

            const selectedBarber = targetBarberId
                ? candidates.find((candidate) => candidate.id === targetBarberId)
                : candidates[0];

            if (!selectedBarber) {
                return res.status(400).json({
                    error: targetBarberId
                        ? 'Selected barber is not available for reassignment'
                        : 'No available barber found for reassignment',
                    candidates,
                });
            }

            const nextCreatedAt = await getQueueTailCreatedAt({
                branchId: entry.branch_id,
                barberId: selectedBarber.id,
            });

            const updateQuery = db
                .from('queue_entries')
                .update({
                    barber_id: selectedBarber.id,
                    created_at: nextCreatedAt,
                    started_at: null,
                    status: 'waiting',
                    swapped_flag: true,
                })
                .eq('id', id)
                .in('status', REASSIGNABLE_QUEUE_STATUSES);
            if (branchId) {
                updateQuery.eq('branch_id', branchId);
            } else {
                updateQuery.eq('barber_id', auth.barberId);
            }

            const { data: updated, error: updateError } = await updateQuery
                .select('id, status, swapped_flag, created_at, started_at, finished_at, service_id, service_ids, payment_method, branch_id, barber_id, client_id, client:clients ( id, name )')
                .maybeSingle();

            if (updateError) {
                return res.status(500).json({ error: updateError.message });
            }
            if (!updated) {
                return res.status(404).json({ error: 'Queue entry not found' });
            }

            clearCallTimer(id);

            const io = req.app.get('io');
            if (io) {
                io.to(`branch:${entry.branch_id}`).emit('queue:update', {
                    type: 'queue_reassigned',
                    entryId: updated.id,
                    branchId: entry.branch_id,
                    fromBarberId: entry.barber_id,
                    barberId: selectedBarber.id,
                });
            }

            return res.json({
                entry: updated,
                target_barber: selectedBarber,
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    async callNext(req, res) {
        const { id } = req.params || {};

        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: "Authorization token is required" });
        }

        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        if (!isBarberWorkspaceRole(payload.role)) {
            return res.status(403).json({ error: 'Only barbers can call queue entries' });
        }

        if (!id) {
            return res.status(400).json({ error: 'Queue entry id is required' });
        }

        const barberId = payload.sub || payload.id;

        const { data: entry, error: entryError } = await db
            .from('queue_entries')
            .select('id, barber_id, status')
            .eq('id', id)
            .eq('barber_id', barberId)
            .maybeSingle();

        if (entryError) {
            return res.status(500).json({ error: entryError.message });
        }
        if (!entry) {
            return res.status(404).json({ error: 'Queue entry not found' });
        }

        if (!['waiting', 'swapped'].includes(entry.status)) {
            return res.status(400).json({ error: 'Only waiting entries can be called' });
        }

        const io = req.app.get('io');

        const { data: updated, error: updateError } = await db
            .from('queue_entries')
            .update({
                status: 'called',
            })
            .eq('id', id)
            .eq('barber_id', barberId)
            .select('id, status, swapped_flag, created_at, service_id, service_ids, payment_method, branch_id, barber_id, client_id, client:clients ( id, name )')
            .maybeSingle();

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        scheduleCallFollowUp(updated, io);
        emitCallEvent(io, updated);

        return res.json({ entry: updated });
    }

    async startQueue(req, res) {
        const { id } = req.params || {};

        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: "Authorization token is required" });
        }

        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        if (!isBarberWorkspaceRole(payload.role)) {
            return res.status(403).json({ error: 'Only barbers can start queue entries' });
        }

        if (!id) {
            return res.status(400).json({ error: 'Queue entry id is required' });
        }

        const barberId = payload.sub || payload.id;

        const { data: entry, error: entryError } = await db
            .from('queue_entries')
            .select('id, barber_id, status')
            .eq('id', id)
            .eq('barber_id', barberId)
            .maybeSingle();

        if (entryError) {
            return res.status(500).json({ error: entryError.message });
        }
        if (!entry) {
            return res.status(404).json({ error: 'Queue entry not found' });
        }

        if (entry.status !== 'called') {
            return res.status(400).json({ error: 'Only called entries can be started' });
        }

        clearCallTimer(id);

        const { data: updated, error: updateError } = await db
            .from('queue_entries')
            .update({
                status: 'in_progress',
                started_at: new Date().toISOString(),
            })
            .eq('id', id)
            .eq('barber_id', barberId)
            .select('id, status, created_at, started_at, service_id, service_ids, payment_method, branch_id')
            .maybeSingle();

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        return res.json({ entry: updated });
    }

    async editBeforeComplete(req, res) {
        const { id } = req.params || {};
        const { amount, reason } = req.body || {};

        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: "Authorization token is required" });
        }

        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        if (!isBarberWorkspaceRole(payload.role)) {
            return res.status(403).json({ error: 'Only barbers can edit price before completion' });
        }

        if (!id) {
            return res.status(400).json({ error: 'Queue entry id is required' });
        }

        const numericAmount = Number(amount);
        if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
            return res.status(400).json({ error: 'amount must be a positive number' });
        }

        if (!reason || !reason.trim()) {
            return res.status(400).json({ error: 'reason is required when editing the final price' });
        }

        // Fetch the cheapest service price to enforce a floor
        const { data: cheapestService, error: serviceError } = await db
            .from('services')
            .select('base_price')
            .order('base_price', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (serviceError) {
            return res.status(500).json({ error: serviceError.message });
        }

        const minServicePrice = cheapestService ? Number(cheapestService.base_price) : null;
        if (minServicePrice && Number.isFinite(minServicePrice) && numericAmount < minServicePrice) {
            return res.status(400).json({ error: `amount cannot be lower than minimum service price ${minServicePrice}` });
        }

        const barberId = payload.sub || payload.id;

        const { data: entry, error: entryError } = await db
            .from('queue_entries')
            .select('id, barber_id, status')
            .eq('id', id)
            .eq('barber_id', barberId)
            .maybeSingle();

        if (entryError) {
            return res.status(500).json({ error: entryError.message });
        }
        if (!entry) {
            return res.status(404).json({ error: 'Queue entry not found' });
        }

        const terminal = ['completed', 'cancelled', 'rejected', 'no_show', 'not_in_time'];
        if (terminal.includes(entry.status)) {
            return res.status(409).json({ error: `Cannot edit price in status ${entry.status}` });
        }

        const updatePayload = {
            price_override: numericAmount,
            price_override_reason: reason.trim(),
            updated_at: new Date().toISOString(),
        };

        const { data: updated, error: updateError } = await db
            .from('queue_entries')
            .update(updatePayload)
            .eq('id', id)
            .eq('barber_id', barberId)
            .select('id, status, branch_id, price_override, price_override_reason')
            .maybeSingle();

        if (updateError) {
            return res.status(500).json({
                error: updateError.message,
                hint: 'Ensure queue_entries has columns price_override numeric and price_override_reason text',
            });
        }

        return res.json({
            entry: updated,
            message: 'Price updated before completion',
        });
    }

    async completeQueueEntry(req, res) {
        const { id } = req.params || {};
        const { payment_method, payments: paymentsInput } = req.body || {};

        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: "Authorization token is required" });
        }

        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        if (!isBarberWorkspaceRole(payload.role)) {
            return res.status(403).json({ error: 'Only barbers can complete queue entries' });
        }

        if (!id) {
            return res.status(400).json({ error: 'Queue entry id is required' });
        }

        const barberId = payload.sub || payload.id;

        let paymentParts;

        try {
            paymentParts = normalizePaymentParts(paymentsInput);
        } catch (error) {
            return res.status(error.statusCode || 400).json({ error: error.message });
        }

        const { data: entry, error: entryError } = await db
            .from('queue_entries')
            .select('id, barber_id, status, service_id, service_ids, payment_method, client_id, price_override')
            .eq('id', id)
            .eq('barber_id', barberId)
            .maybeSingle();

        if (entryError) {
            return res.status(500).json({ error: entryError.message });
        }
        if (!entry) {
            return res.status(404).json({ error: 'Queue entry not found' });
        }

        if (entry.status === 'completed') {
            return res.status(400).json({ error: 'Queue entry is already completed' });
        }

        let orderAmount = 0;
        let finalPaymentMethod = null;

        try {
            orderAmount = await getQueueEntryAmount(entry);
            finalPaymentMethod = getFinalPaymentMethod({
                currentMethod: entry.payment_method,
                paymentMethod: payment_method,
                payments: paymentParts,
            });
        } catch (error) {
            return res.status(error.statusCode || 500).json({ error: error.message });
        }

        const paidAmount = roundMoneyAmount(paymentParts.reduce((sum, payment) => sum + payment.amount, 0));

        if (paymentParts.length && orderAmount > 0 && Math.abs(paidAmount - orderAmount) >= 0.01) {
            return res.status(400).json({
                error: 'Payment parts total must match queue entry amount',
                expected_amount: orderAmount,
                paid_amount: paidAmount,
            });
        }

        clearCallTimer(id);

        const updatePayload = {
            status: 'completed',
            finished_at: new Date().toISOString(),
            ...(finalPaymentMethod ? { payment_method: finalPaymentMethod } : {}),
        };

        const { data: updated, error: updateError } = await db
            .from('queue_entries')
            .update(updatePayload)
            .eq('id', id)
            .eq('barber_id', barberId)
            .select('id, status, created_at, finished_at, service_id, service_ids, payment_method, branch_id, client_id, price_override, price_override_reason')
            .maybeSingle();

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        let payments = [];

        try {
            payments = await replaceQueueEntryPayments({
                payments: paymentParts,
                queueEntryId: id,
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }

        const cashback = await awardCashbackForCompletedQueueEntry(updated);

        return res.json({ entry: { ...updated, payments }, cashback });
    }

    async updateProfile(req, res) {
        const { photo_url, image_base64, content_type } = req.body || {};

        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: "Authorization token is required" });
        }

        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: "Invalid or expired token" });
        }

        if (!isBarberWorkspaceRole(payload.role)) {
            return res.status(403).json({ error: 'Only barbers can update their profile' });
        }

        const barberId = payload.sub || payload.id;

        const allowedKeys = ['photo_url', 'image_base64', 'content_type'];
        if (req.body && Object.keys(req.body).some((k) => !allowedKeys.includes(k))) {
            return res.status(400).json({ error: 'Only photo updates are allowed (photo_url, image_base64, content_type, or multipart file)' });
        }

        if (!photo_url && !image_base64 && !req.file) {
            return res.status(400).json({ error: 'Provide photo_url, image_base64, or upload a file field named "file"' });
        }

        let finalPhotoUrl = photo_url || null;

        if (!finalPhotoUrl && req.file) {
            const { buffer, mimetype } = req.file;
            const { data: uploadRes, error: uploadErr } = await uploadBufferImage(
                buffer,
                mimetype || 'image/png',
                barberId
            );
            if (uploadErr) {
                return res.status(500).json({ error: uploadErr.message || 'Failed to upload image' });
            }
            finalPhotoUrl = uploadRes?.publicUrl || null;
        }

        if (!finalPhotoUrl && image_base64) {
            try {
                const { data: uploadRes, error: uploadErr } = await uploadBase64Image(
                    image_base64,
                    content_type,
                    barberId
                );
                if (uploadErr) {
                    return res.status(500).json({ error: uploadErr.message || 'Failed to upload image' });
                }
                finalPhotoUrl = uploadRes?.publicUrl || null;
                if (!finalPhotoUrl) {
                    return res.status(500).json({ error: 'Failed to generate public URL for uploaded image' });
                }
            } catch (e) {
                return res.status(500).json({ error: e.message || 'Failed to upload image' });
            }
        }

        const updatePayload = { photo_url: finalPhotoUrl };

        const { data: updated, error: updateError } = await db
            .from('barbers')
            .update(updatePayload)
            .eq('id', barberId)
            .select('id, name, photo_url, branch_id, is_authorized, is_on_shift, specialization')
            .maybeSingle();

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        return res.json({ barber: updated });
    }

    async logout(req, res) {
        try {
            const { barber_id, is_on_shift = false } = req.body;

            const { data: updated, error: updateError } = await db
                .from('barbers')
                .update({ is_on_shift })
                .eq('id', barber_id)
                .select('id, name, photo_url, branch_id, is_authorized, is_on_shift, specialization')
                .maybeSingle();

            if (updateError) {
                return res.status(500).json({ error: updateError.message });
            }

            if (updated) {
                await logVerifixEvent({
                    barberId: updated.id,
                    branchId: updated.branch_id,
                    eventType: 'logout',
                    io: req.app.get('io'),
                    metadata: { is_on_shift },
                });
            }

            return res.json({ barber: updated });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    async markNoShow(req, res) {
        const { id } = req.params || {};
        const { no_show = true } = req.body || {};

        const { data: updated, error: updateError } = await db
            .from('queue_entries')
            .update({ status: no_show ? 'no_show' : 'waiting', finished_at: no_show ? new Date().toISOString() : null })
            .eq('id', id)
            .select('id, client_id, barber_id, status, finished_at')
            .maybeSingle();

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        if (!updated) {
            return res.status(404).json({ error: 'Queue entry not found' });
        }

        return res.json({ queue_entry: updated });
    }

    async markNotInTime(req, res) {
        const { id } = req.params || {};

        if (!id) return res.status(400).json({ error: 'Queue entry id is required' });

        clearCallTimer(id);

        const { data: updated, error: updateError } = await db
            .from('queue_entries')
            .update({ status: 'not_in_time', finished_at: new Date().toISOString() })
            .eq('id', id)
            .select('id, client_id, barber_id, status, finished_at')
            .maybeSingle();

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        if (!updated) {
            return res.status(404).json({ error: 'Queue entry not found' });
        }

        return res.json({ queue_entry: updated });
    }
}



module.exports = new Barbers();

