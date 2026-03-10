const { supabase } = require("../config/supabase");
const bcrypto = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { uploadBase64ToSupabase, uploadBufferToSupabase } = require("../composable/uploadImage");

const shiftAutoOffTimers = new Map();
const breakTimers = new Map(); // barberId -> { timer, startedAt: Date, until: Date }
const callTimers = new Map(); // queueEntryId -> timer

const CALL_LATE_MINUTES = 10;
const STALE_QUEUE_HOURS = 9;

async function endBreak(barberId, branchId, io) {
    await supabase
        .from('barbers')
        .update({ is_on_shift: true })
        .eq('id', barberId);
    if (io) {
        io.to(`branch:${branchId}`).emit('queue:update', {
            type: 'barber_status',
            barberId,
            is_on_shift: true,
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
            await supabase
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

const clearCallTimer = (entryId) => {
    const timer = callTimers.get(entryId);
    if (timer) {
        clearTimeout(timer);
        callTimers.delete(entryId);
    }
};

const markEntriesNoShow = async ({ barberId, branchId, cutoffIso }) => {
    const query = supabase
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

    const { data: nextEntry, error: nextError } = await supabase
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

    const { data: updated, error: updateError } = await supabase
        .from('queue_entries')
        .update(updatePayload)
        .eq('id', id)
        .select('id, status, swapped_flag, created_at, branch_id, barber_id')
        .maybeSingle();

    if (updateError) throw new Error(updateError.message);
    return updated;
};

const markNoShow = async (entryId) => {
    const { data, error } = await supabase
        .from('queue_entries')
        .update({ status: 'no_show', finished_at: new Date().toISOString() })
        .eq('id', entryId)
        .select('id, branch_id, barber_id, status')
        .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
};

const scheduleCallFollowUp = (entry, io) => {
    if (!entry?.id) return;
    clearCallTimer(entry.id);

    const timer = setTimeout(async () => {
        callTimers.delete(entry.id);
        try {
            const { data: fresh, error } = await supabase
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

process.on('SIGTERM', cleanupShiftTimers);
process.on('SIGINT', cleanupShiftTimers);

class Barbers {
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

        if (payload.role !== 'barber') {
            return res.status(403).json({ error: 'Only barbers can take a break' });
        }

        const minutesRaw = req.body?.minutes ?? 15;
        const minutes = Number(minutesRaw);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) {
            return res.status(400).json({ error: 'minutes must be between 1 and 180' });
        }

        const barberId = payload.sub || payload.id;

        const { data: barber, error: barberError } = await supabase
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
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
            return res.json({ status: 'ok', ended_early: true });
        }

        const { error: updateError } = await supabase
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

        if (payload.role !== 'barber') {
            return res.status(403).json({ error: 'Only barbers can return from break' });
        }

        const barberId = payload.sub || payload.id;

        const { data: barber, error: barberError } = await supabase
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

        const { error: updateError } = await supabase
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

        return res.json({ status: 'ok' });
    }

    async login(req, res) {
        const {
            login, password, branch_id
        } = req.body || {};

        if (!login || !password) {
            return res.status(400).json({ error: 'Login and password are required' });
        }

        if (!branch_id) return res.status(400).json({ error: 'Branch ID is required' });

        const { data: users, error: barberError } = await supabase
            .from('users')
            .select('*')
            .eq('login', login)
            .eq('role', 'barber')
            .limit(1);

        if (barberError) {
            return res.status(500).json({ error: 'Failed to verify credentials' });
        }

        const barberData = Array.isArray(users) ? users[0] : null;
        if (!barberData) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const passwordCheck = bcrypto.compareSync(password, barberData.password_hash);
        if (!passwordCheck) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        await supabase
            .from('users')
            .update({ branch_id })
            .eq('id', barberData.id);
        await supabase
            .from('barbers')
            .update({ branch_id, is_on_shift: true })
            .eq('id', barberData.id);

        const token = jwt.sign(
            {
                sub: barberData.id,
                login: barberData.login,
                role: barberData.role,
                branchId: branch_id,
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
                branch_id,
            },
        });
    }

    async register(req, res) {
        const { login, password, name, branch_id = null, phone, specialization = null } = req.body || {};

        if (!login || !password || !name || !branch_id) {
            return res.status(400).json({ error: 'login, password, name, and branch_id are required' });
        }

        if (String(password).length < 6) {
            return res.status(400).json({ error: 'password must be at least 6 characters' });
        }

        const { data: existing, error: existingError } = await supabase
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

        const { data: userRow, error: userError } = await supabase
            .from('users')
            .insert({ login, password_hash, role: 'barber', branch_id })
            .select('id, login, role, branch_id')
            .maybeSingle();

        if (userError || !userRow) {
            return res.status(500).json({ error: userError?.message || 'failed to create user' });
        }

        const barberPayload = {
            id: userRow.id,
            name,
            branch_id,
            phone: phone || null,
            specialization: specialization || null,
            is_on_shift: false,
        };

        const { data: barberRow, error: barberError } = await supabase
            .from('barbers')
            .insert(barberPayload)
            .select('id, name, branch_id, phone, specialization, is_on_shift, is_authorized, photo_url')
            .maybeSingle();

        if (barberError || !barberRow) {
            await supabase.from('users').delete().eq('id', userRow.id);
            return res.status(500).json({ error: barberError?.message || 'failed to create barber' });
        }

        return res.status(201).json({
            user: userRow,
            barber: barberRow,
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
            const io = req.app.get('io');
            const breakInfo = breakTimers.get(user.id);
            // auto-finish break if timer elapsed (for safety)
            if (breakInfo && breakInfo.until <= new Date()) {
                clearTimeout(breakInfo.timer);
                breakTimers.delete(user.id);
                try {
                    await endBreak(user.id, barberData.branch_id, io);
                    barberData.is_on_shift = true;
                } catch (e) {
                    // ignore, return current state
                }
            }
            const updatedBreak = breakTimers.get(user.id);
            barber = {
                ...barberData,
                break_started_at: updatedBreak?.startedAt ? updatedBreak.startedAt.toISOString() : null,
                break_until: updatedBreak?.until ? updatedBreak.until.toISOString() : null,
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

        if (payload.role !== 'barber') {
            return res.status(403).json({ error: 'Only barbers can view their queue' });
        }

        const barberId = payload.sub || payload.id;

        const cutoffIso = new Date(Date.now() - STALE_QUEUE_HOURS * 60 * 60 * 1000).toISOString();
        try {
            await markEntriesNoShow({ barberId, cutoffIso });
        } catch (e) {
            console.error('stale queue cleanup failed:', e.message);
        }

        const { data, error } = await supabase
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
            .order('created_at', { ascending: true });

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

        return res.json({
            items: filtered,
            count: Array.isArray(filtered) ? filtered.length : 0,
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

        if (data.status === 'completed') {
            return res.status(209).json({ warning: "completed", data });
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
            .select('id, status, swapped_flag, created_at, finished_at, service_id, service_ids, payment_method, branch_id, barber_id, client_id, client:clients ( id, name )')
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

        return res.json({ entry: updated });
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

        if (payload.role !== 'barber') {
            return res.status(403).json({ error: 'Only barbers can call queue entries' });
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

        if (!['waiting', 'swapped'].includes(entry.status)) {
            return res.status(400).json({ error: 'Only waiting entries can be called' });
        }

        const io = req.app.get('io');

        const { data: updated, error: updateError } = await supabase
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

        if (payload.role !== 'barber') {
            return res.status(403).json({ error: 'Only barbers can start queue entries' });
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

        if (entry.status !== 'called') {
            return res.status(400).json({ error: 'Only called entries can be started' });
        }

        clearCallTimer(id);

        const { data: updated, error: updateError } = await supabase
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

        if (payload.role !== 'barber') {
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
        const { data: cheapestService, error: serviceError } = await supabase
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

        const terminal = ['completed', 'cancelled', 'rejected', 'no_show'];
        if (terminal.includes(entry.status)) {
            return res.status(409).json({ error: `Cannot edit price in status ${entry.status}` });
        }

        const updatePayload = {
            price_override: numericAmount,
            price_override_reason: reason.trim(),
            updated_at: new Date().toISOString(),
        };

        const { data: updated, error: updateError } = await supabase
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
            return res.status(403).json({ error: 'Only barbers can complete queue entries' });
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

        if (entry.status === 'completed') {
            return res.status(400).json({ error: 'Queue entry is already completed' });
        }

        clearCallTimer(id);

        const { data: updated, error: updateError } = await supabase
            .from('queue_entries')
            .update({
                status: 'completed',
                finished_at: new Date().toISOString(),
            })
            .eq('id', id)
            .eq('barber_id', barberId)
            .select('id, status, created_at, finished_at, service_id, service_ids, payment_method, branch_id')
            .maybeSingle();

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        return res.json({ entry: updated });
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

        if (payload.role !== 'barber') {
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
            const { data: uploadRes, error: uploadErr } = await uploadBufferToSupabase(
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
                const { data: uploadRes, error: uploadErr } = await uploadBase64ToSupabase(
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

        const { data: updated, error: updateError } = await supabase
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

            const { data: updated, error: updateError } = await supabase
                .from('barbers')
                .update({ is_on_shift })
                .eq('id', barber_id)
                .select('id, name, photo_url, branch_id, is_authorized, is_on_shift, specialization')
                .maybeSingle();

            if (updateError) {
                return res.status(500).json({ error: updateError.message });
            }

            return res.json({ barber: updated });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    async markNoShow(req, res) {
        const { id } = req.params || {};
        const { no_show = true } = req.body || {};

        const { data: updated, error: updateError } = await supabase
            .from('queue_entries')
            .update({ status: no_show ? 'no_show' : 'waiting' })
            .eq('id', id)
            .select('id, client_id, barber_id, status')
            .maybeSingle();

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        return res.json({ queue_entry: updated });
    }
}



module.exports = new Barbers();

