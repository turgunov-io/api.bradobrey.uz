const jwt = require('jsonwebtoken');
const { db } = require('../config/postgres');
const EMPLOYEE_ROLES = ['admin_network', 'admin_branch', 'admin', 'manager', 'super-manager', 'super-barber', 'barber'];

async function ensureNotificationsTable() {
    await db.query(`
        create table if not exists notifications (
          id uuid default gen_random_uuid() primary key,
          recipient_user_id uuid not null references users(id) on delete cascade,
          type text not null default 'suspicious_order',
          title text not null,
          body text not null,
          order_id uuid references queue_entries(id) on delete cascade,
          branch_id uuid references branches(id) on delete set null,
          data jsonb not null default '{}'::jsonb,
          read_at timestamptz,
          created_at timestamptz not null default now()
        );
        create unique index if not exists notifications_recipient_type_order_idx on notifications (recipient_user_id, type, order_id);
        create index if not exists notifications_recipient_created_idx on notifications (recipient_user_id, created_at desc);
    `);
}

function authenticate(req, res) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) { res.status(401).json({ error: 'Authorization token is required' }); return null; }
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        if (!EMPLOYEE_ROLES.includes(payload?.role)) { res.status(403).json({ error: 'Notifications are not available for this role' }); return null; }
        return payload;
    }
    catch (_error) { res.status(401).json({ error: 'Invalid or expired token' }); return null; }
}

async function createSuspiciousOrderNotifications(entry) {
    if (!entry?.id || !entry?.branch_id) return;
    const ids = Array.from(new Set([...(Array.isArray(entry.service_ids) ? entry.service_ids : []), ...(entry.service_id ? [entry.service_id] : [])].filter(Boolean)));
    const { data: services, error: serviceError } = ids.length ? await db.from('services').select('id, duration_minutes').in('id', ids) : { data: [], error: null };
    if (serviceError) throw new Error(serviceError.message);
    const expected = ids.reduce((sum, id) => sum + (Number((services || []).find(s => String(s.id) === String(id))?.duration_minutes) || 0), 0);
    const actual = (new Date(entry.finished_at).getTime() - new Date(entry.started_at || entry.created_at).getTime()) / 60000;
    if (entry.status !== 'completed' || !expected || !Number.isFinite(actual) || actual < 0 || actual >= expected * 0.5) return;
    const [{ data: barber }, { data: recipients, error: recipientError }] = await Promise.all([
        db.from('barbers').select('name').eq('id', entry.barber_id).maybeSingle(),
        db.from('users').select('id, role, branch_id').in('role', EMPLOYEE_ROLES),
    ]);
    if (recipientError) throw new Error(recipientError.message);
    const barberName = barber?.name || 'Неизвестный барбер';
    const clientName = entry.client?.name || 'Клиент';
    const body = `${barberName} • ${clientName} • заказ #${String(entry.id).slice(0, 8)} • ${Math.round(actual)} мин. при норме ${expected} мин.`;
    const rows = (recipients || []).filter(user => ['admin_network', 'admin', 'super-manager', 'super-barber'].includes(user.role) || String(user.branch_id) === String(entry.branch_id)).map(user => ({
        recipient_user_id: user.id, type: 'suspicious_order', title: 'Подозрительный заказ', body, order_id: entry.id, branch_id: entry.branch_id,
        data: { barber_name: barberName, client_name: clientName, actual_minutes: actual, expected_minutes: expected },
    }));
    if (rows.length) { const { error } = await db.from('notifications').upsert(rows, { onConflict: 'recipient_user_id,type,order_id', ignoreDuplicates: true }); if (error) throw new Error(error.message); }
}

class Notifications {
    async list(req, res) {
        const payload = authenticate(req, res); if (!payload) return;
        const userId = payload.sub || payload.id; const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
        let query = db.from('notifications').select('*', { count: 'exact' }).eq('recipient_user_id', userId).order('created_at', { ascending: false }).limit(limit);
        if (['1', 'true', 'yes'].includes(String(req.query.unread).toLowerCase())) query = query.is('read_at', null);
        const { data, error, count } = await query; if (error) return res.status(500).json({ error: error.message });
        const { count: unreadCount, error: unreadError } = await db.from('notifications').select('id', { count: 'exact', head: true }).eq('recipient_user_id', userId).is('read_at', null);
        if (unreadError) return res.status(500).json({ error: unreadError.message });
        return res.json({ items: data || [], count: count || 0, unread_count: unreadCount || 0 });
    }
    async read(req, res) { const payload = authenticate(req, res); if (!payload) return; const { data, error } = await db.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', req.params.id).eq('recipient_user_id', payload.sub || payload.id).select('*').maybeSingle(); if (error) return res.status(500).json({ error: error.message }); if (!data) return res.status(404).json({ error: 'Notification not found' }); return res.json({ item: data }); }
    async readAll(req, res) { const payload = authenticate(req, res); if (!payload) return; const { error } = await db.from('notifications').update({ read_at: new Date().toISOString() }).eq('recipient_user_id', payload.sub || payload.id).is('read_at', null); if (error) return res.status(500).json({ error: error.message }); return res.json({ success: true }); }
}
module.exports = { notifications: new Notifications(), createSuspiciousOrderNotifications, ensureNotificationsTable };
