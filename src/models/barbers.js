const { supabase } = require("../config/supabase");
const bcrypto = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { uploadBase64ToSupabase, uploadBufferToSupabase } = require("../composable/uploadImage");

const shiftAutoOffTimers = new Map();

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
            .select('*')
            .eq('login', login)
            .single();

        if (barberError) {
            return res.status(400).json({ error: barberError.message });
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

        if (entry.status !== 'waiting') {
            return res.status(400).json({ error: 'Only waiting entries can be called' });
        }

        const { data: updated, error: updateError } = await supabase
            .from('queue_entries')
            .update({
                status: 'called',
            })
            .eq('id', id)
            .eq('barber_id', barberId)
            .select('id, status, created_at, service_id, service_ids, payment_method, branch_id')
            .maybeSingle();

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

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

    async toggleShiftStatus(req, res) {
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
            return res.status(403).json({ error: 'Only barbers can toggle their shift status' });
        }

        const barberId = payload.sub || payload.id;
        const autoOffMinutesRaw = req.body?.auto_off_minutes;
        const autoOffMinutes = Number.isFinite(Number(autoOffMinutesRaw)) ? Number(autoOffMinutesRaw) : null;

        const { data: barber, error: barberError } = await supabase
            .from('barbers')
            .select('id, is_on_shift')
            .eq('id', barberId)
            .maybeSingle();

        if (barberError) {
            return res.status(500).json({ error: barberError.message });
        }
        if (!barber) {
            return res.status(404).json({ error: 'Barber not found' });
        }

        const newShiftStatus = !barber.is_on_shift;

        const { data: updated, error: updateError } = await supabase
            .from('barbers')
            .update({ is_on_shift: newShiftStatus })
            .eq('id', barberId)
            .select('id, name, photo_url, branch_id, is_authorized, is_on_shift, specialization')
            .maybeSingle();

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        if (newShiftStatus === true && autoOffMinutes && autoOffMinutes > 0) {
            if (shiftAutoOffTimers.has(barberId)) {
                clearTimeout(shiftAutoOffTimers.get(barberId));
            }
            const ms = autoOffMinutes * 60 * 1000;
            const timer = setTimeout(async () => {
                shiftAutoOffTimers.delete(barberId);
                try {
                    await supabase
                        .from('barbers')
                        .update({ is_on_shift: false })
                        .eq('id', barberId);
                } catch (e) {
                    console.log(e.message)
                }
            }, ms);
            shiftAutoOffTimers.set(barberId, timer);
        } else if (newShiftStatus === false && shiftAutoOffTimers.has(barberId)) {
            clearTimeout(shiftAutoOffTimers.get(barberId));
            shiftAutoOffTimers.delete(barberId);
        }

        return res.json({ barber: updated, auto_off_minutes: newShiftStatus ? autoOffMinutes || null : null });
    }
}



module.exports = new Barbers();
