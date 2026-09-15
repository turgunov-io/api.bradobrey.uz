const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const { db } = require('../config/postgres');
const EMPLOYEE_ROLES = ['admin_network', 'admin_branch', 'admin', 'manager', 'super-manager', 'super-barber', 'barber'];

function configureWebPush() {
    const publicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
    const privateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
    const subject = String(process.env.VAPID_SUBJECT || 'mailto:admin@bradobrey.uz').trim();
    if (!publicKey || !privateKey) return false;
    webpush.setVapidDetails(subject, publicKey, privateKey);
    return true;
}

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
        create table if not exists push_subscriptions (
          id uuid default gen_random_uuid() primary key,
          user_id uuid not null references users(id) on delete cascade,
          endpoint text not null unique,
          p256dh text not null,
          auth text not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
        create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);
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
    if (rows.length) {
        const inserted = [];
        for (const row of rows) {
            const result = await db.query(`
                insert into notifications (recipient_user_id, type, title, body, order_id, branch_id, data)
                values ($1, $2, $3, $4, $5, $6, $7::jsonb)
                on conflict (recipient_user_id, type, order_id) do nothing
                returning recipient_user_id, title, body, order_id, branch_id, data
            `, [row.recipient_user_id, row.type, row.title, row.body, row.order_id, row.branch_id, JSON.stringify(row.data || {})]);
            inserted.push(...(result.rows || []));
        }
        await Promise.allSettled(inserted.map(notification => sendPushToUser(notification.recipient_user_id, {
            title: notification.title,
            body: notification.body,
            url: notification.order_id ? `/history?scope=all&order_id=${notification.order_id}` : '/notifications',
            tag: `suspicious-order-${notification.order_id || notification.recipient_user_id}`
        })));
    }
}

async function sendPushToUser(userId, payload) {
    if (!configureWebPush()) return;
    const result = await db.query('select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1', [userId]);
    await Promise.all(result.rows.map(async (subscription) => {
        try {
            await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(payload));
        }
        catch (error) {
            if ([404, 410].includes(error?.statusCode)) {
                await db.query('delete from push_subscriptions where id = $1', [subscription.id]);
                return;
            }
            console.error('Push notification failed:', error.message);
        }
    }));
}

class Notifications {
    async savePushSubscription(req, res) {
        const payload = authenticate(req, res); if (!payload) return;
        const subscription = req.body || {};
        const endpoint = String(subscription.endpoint || '').trim();
        const keys = subscription.keys || {};
        if (!endpoint || !keys.p256dh || !keys.auth) return res.status(400).json({ error: 'Invalid push subscription' });
        try {
            await db.query(`
                insert into push_subscriptions (user_id, endpoint, p256dh, auth, updated_at)
                values ($1, $2, $3, $4, now())
                on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = now()
            `, [payload.sub || payload.id, endpoint, String(keys.p256dh), String(keys.auth)]);
            return res.json({ success: true });
        }
        catch (error) { return res.status(500).json({ error: error.message }); }
    }

    async testPush(req, res) {
        const payload = authenticate(req, res); if (!payload) return;
        if (!configureWebPush()) return res.status(503).json({ error: 'VAPID keys are not configured' });
        try {
            await sendPushToUser(payload.sub || payload.id, { title: 'Тестовое уведомление', body: 'Push работает на этом устройстве.', url: '/notifications', tag: 'test-push' });
            return res.json({ success: true });
        }
        catch (error) { return res.status(500).json({ error: error.message }); }
    }

    async checkToday(req, res) {
        const payload = authenticate(req, res); if (!payload) return;
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date || '')) ? String(req.body.date) : new Date().toISOString().slice(0, 10);
        const from = `${date}T00:00:00.000Z`;
        const to = new Date(Date.parse(from) + 86400000).toISOString();
        const { data: orders, error } = await db.from('queue_entries').select('id, status, created_at, started_at, finished_at, service_id, service_ids, branch_id, barber_id, client:clients ( name )').eq('status', 'completed').gte('finished_at', from).lt('finished_at', to);
        if (error) return res.status(500).json({ error: error.message });
        let suspiciousCount = 0;
        for (const order of orders || []) {
            const before = await db.from('notifications').select('id', { count: 'exact' }).eq('order_id', order.id).eq('type', 'suspicious_order');
            await createSuspiciousOrderNotifications(order);
            const after = await db.from('notifications').select('id', { count: 'exact' }).eq('order_id', order.id).eq('type', 'suspicious_order');
            if ((after.count || 0) > (before.count || 0)) suspiciousCount += 1;
        }
        return res.json({ checked_count: (orders || []).length, suspicious_count: suspiciousCount, date });
    }

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
