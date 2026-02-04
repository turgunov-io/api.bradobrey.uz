const { supabase } = require("../config/supabase");
const bcrypto = require("bcryptjs");
const jwt = require("jsonwebtoken");

class Barbers {
    async login(req, res) {
        const {
            login, password, branch_id
        } = req.body || {};

        if (!login || !password) {
            return res.status(400).json({ error: 'Login and password are required' });
        }

        if (!branch_id) return res.status(400).json({ error: 'Branch ID is required' });

        const { data: barberData, error: barberError } = await supabase
            .from('users')
            .select('id, login, password_hash, role, branch_id')
            .eq('login', login)
            .single();

        if (barberError) {
            return res.status(400).json({ error: barberError.message });
        }

        const passwordCheck = bcrypto.compareSync(password, barberData.password_hash);
        if (!passwordCheck) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            {
                sub: barberData.id,
                login: barberData.login,
                role: barberData.role,
                branchId: barberData.branch_id,
            },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
        );

        return res.json({
            token,
            user: {
                id: barberData.id,
                login: barberData.login,
                role: barberData.role,
                branch_id: barberData.branch_id,
            },
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

        const { data: user, error: userError } = await supabase
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
        if (user.role === 'barber') {
            const { data: barberData, error: barberError } = await supabase
                .from('barbers')
                .select('id, name, photo_url, branch_id, is_authorized, is_on_shift, specialization')
                .eq('id', user.id)
                .maybeSingle();

            if (barberError) {
                return res.status(500).json({ error: barberError.message });
            }
            barber = barberData;
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

        if (payload.role !== 'barber') {
            return res.status(403).json({ error: 'Only barbers can view their queue' });
        }

        const barberId = payload.sub || payload.id;

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
            .eq('barber_id', barberId)
            .in('status', ['waiting', 'called', 'in_progress'])
            .order('created_at', { ascending: true });

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        return res.json({
            items: data || [],
            count: Array.isArray(data) ? data.length : 0,
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

        if (payload.role !== 'barber') {
            return res.status(403).json({ error: 'Only barbers can view queue entries' });
        }

        const barberId = payload.sub || payload.id;

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
            .eq('id', id)
            .eq('barber_id', barberId)
            .maybeSingle();

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        if (!data) {
            return res.status(404).json({ error: 'Queue entry not found' });
        }

        return res.status(200).json(data);
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

        if (payload.role !== 'barber') {
            return res.status(403).json({ error: 'Only barbers can edit their queue entries' });
        }

        if (!id) {
            return res.status(400).json({ error: 'Queue entry id is required' });
        }

        const barberId = payload.sub || payload.id;

        const { data: entry, error: entryError } = await supabase
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

        const allowedStatuses = [
            'waiting',
            'called',
            'in_progress',
            'completed',
            'cancelled',
            'rejected',
            'swapped',
            'no_show',
        ];

        const updatePayload = {};

        if (status !== undefined) {
            if (!allowedStatuses.includes(status)) {
                return res.status(400).json({ error: 'Invalid status value' });
            }
            updatePayload.status = status;
            if (['completed', 'cancelled', 'rejected', 'no_show'].includes(status)) {
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

        const { data: updated, error: updateError } = await supabase
            .from('queue_entries')
            .update(updatePayload)
            .eq('id', id)
            .eq('barber_id', barberId)
            .select('id, status, created_at, finished_at, service_id, service_ids, payment_method, branch_id')
            .maybeSingle();

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        return res.json({ entry: updated });
    }
}

module.exports = new Barbers();
