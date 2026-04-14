const jwt = require('jsonwebtoken');
const { supabase } = require('../config/supabase');
const { enrichQueueEntriesWithBenefits } = require('../composable/enrichQueueBenefits');

class History {
    async barber(req, res) {
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

        if (payload.role !== 'barber') {
            return res.status(403).json({ error: 'Only barbers can view history' });
        }

        const barberId = payload.sub || payload.id;

        const statusesParam = req.query?.status;
        const statusList = Array.isArray(statusesParam)
            ? statusesParam
            : statusesParam
                ? String(statusesParam).split(',').map((s) => s.trim()).filter(Boolean)
                : ['completed', 'cancelled', 'not_in_time'];

        const allowedStatuses = ['completed', 'cancelled', 'not_in_time'];
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
                branch_id,
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
                branch_id,
                client:clients ( id, name, phone )
            `;

        let query = supabase
            .from('queue_entries')
            .select(selectWithCertificate, { count: 'exact' })
            .eq('barber_id', barberId)
            .in('status', finalStatuses)
            .order('finished_at', { ascending: false })
            .range(offset, offset + limit - 1);

        let { data, error, count } = await query;

        if (error && String(error.message || '').includes("Could not find the 'certificate_id' column")) {
            query = supabase
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

        const enriched = await enrichQueueEntriesWithBenefits(data || []);

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

        // all?filter=retention
        // all?filter=loyal
        // all?filter=all

        const { data, error, count } = await supabase
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
            client:clients ( id, name, phone ),
            barber:barbers ( id, name )
        `, { count: 'exact' })
            .order('finished_at', { ascending: false })
            .limit(100);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        const items = data || [];

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
            count: filtered.length
        });
    }

    async branch(req, res) {
        const id = req.query.id;
        if (!id) return res.status(400).json({ error: "Branch ID is required!" });

        const { data, error } = await supabase
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
            .eq('branch_id', id);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        return res.json({ data: data })
    }
}

module.exports = new History();
