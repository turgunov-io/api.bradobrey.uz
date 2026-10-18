const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const { db } = require('../config/postgres');
const { classifyCompletedOrder } = require('../services/employeeQuality');
const marketplacePush = require('../services/marketplacePush');
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
        create table if not exists employee_push_tokens (
          token text primary key,
          user_id uuid not null references users(id) on delete cascade,
          platform text not null check (platform in ('ANDROID', 'IOS')),
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
        create index if not exists employee_push_tokens_user_idx on employee_push_tokens (user_id);
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

function normalizePersistedQualityAssessment(assessment) {
    if (!assessment) return null;
    return {
        ...assessment,
        actual_minutes: assessment.actual_duration_minutes,
        expected_minutes: assessment.expected_duration_minutes,
    };
}

async function createSuspiciousOrderNotifications(entry) {
    if (!entry?.id || !entry?.branch_id) return;
    const assessmentResult = await db.from('queue_quality_assessments')
        .select('queue_entry_id, service_ids, expected_duration_minutes, actual_duration_minutes, classifiable, suspicious, unclassified_reason, rule_version, assessment_source, data_confidence, review_state')
        .eq('queue_entry_id', entry.id)
        .maybeSingle();
    const missingAssessmentSchema = assessmentResult.error
        && (['42P01', '42703'].includes(assessmentResult.error.code)
            || /(queue_quality_assessments|column).*does not exist/i.test(assessmentResult.error.message || ''));
    if (assessmentResult.error && !missingAssessmentSchema) throw new Error(assessmentResult.error.message);
    const assessment = normalizePersistedQualityAssessment(assessmentResult.data);
    const ids = Array.from(new Set((assessment?.service_ids?.length
        ? assessment.service_ids
        : [...(Array.isArray(entry.service_ids) ? entry.service_ids : []), ...(entry.service_id ? [entry.service_id] : [])]
    ).filter(Boolean)));
    const { data: services, error: serviceError } = ids.length ? await db.from('services').select('id, name, duration_minutes').in('id', ids) : { data: [], error: null };
    if (serviceError) throw new Error(serviceError.message);
    const expected = ids.reduce((sum, id) => sum + (Number((services || []).find(s => String(s.id) === String(id))?.duration_minutes) || 0), 0);
    const quality = assessment || {
        ...classifyCompletedOrder({
            employeeId: entry.barber_id,
            expectedMinutes: expected,
            finishedAt: entry.finished_at,
            startedAt: entry.started_at,
        }),
        assessment_source: 'runtime_fallback_current_catalog',
        data_confidence: 'approximate',
        review_state: null,
    };
    const activeSuspicion = quality.suspicious
        && (quality.review_state === null || ['unreviewed', 'confirmed'].includes(quality.review_state));
    if (entry.status !== 'completed' || !activeSuspicion) return;
    const actual = quality.actual_minutes;
    const assessedExpected = Number(quality.expected_duration_minutes ?? quality.expected_minutes ?? expected);
    const [{ data: barber }, { data: branch }, { data: recipients, error: recipientError }] = await Promise.all([
        db.from('barbers').select('name').eq('id', entry.barber_id).maybeSingle(),
        db.from('branches').select('name').eq('id', entry.branch_id).maybeSingle(),
        db.from('users').select('id, role, branch_id').in('role', EMPLOYEE_ROLES),
    ]);
    if (recipientError) throw new Error(recipientError.message);
    const barberName = barber?.name || 'Неизвестный барбер';
    const branchName = branch?.name || 'Неизвестный филиал';
    const clientName = entry.client?.name || 'Клиент';
    const serviceNames = ids
        .map(id => (services || []).find(service => String(service.id) === String(id))?.name)
        .filter(Boolean)
        .join(', ') || 'Услуга не указана';
    const title = `${clientName} — информация по заказу`;
    const body = `Филиал: ${branchName} • Мастер: ${barberName} • Услуга: ${serviceNames} • Время: ${Math.round(actual)} мин. из ${assessedExpected} мин.`;
    const rows = (recipients || []).filter(user => ['admin_network', 'admin', 'super-manager', 'super-barber'].includes(user.role) || String(user.branch_id) === String(entry.branch_id)).map(user => ({
        recipient_user_id: user.id, type: 'suspicious_order', title, body, order_id: entry.id, branch_id: entry.branch_id,
        data: {
            branch_name: branchName,
            barber_name: barberName,
            service_name: serviceNames,
            client_name: clientName,
            actual_minutes: actual,
            expected_minutes: assessedExpected,
            quality_assessment_source: quality.assessment_source,
            quality_data_confidence: quality.data_confidence,
            quality_rule_version: quality.rule_version,
        },
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
            // Open the inbox first. The user can then choose "Подробнее" on
            // the notification row to open the related order in history.
            url: '/notifications',
            tag: `suspicious-order-${notification.order_id || notification.recipient_user_id}`
        })));
    }
}

async function createLocationWarningNotifications({ barberId, branchId, event }) {
    const [{ data: barber }, { data: branch }, { data: recipients, error }] = await Promise.all([
        db.from('barbers').select('name').eq('id', barberId).maybeSingle(),
        db.from('branches').select('name').eq('id', branchId).maybeSingle(),
        db.from('users').select('id, role, branch_id').in('role', EMPLOYEE_ROLES),
    ]);
    if (error) throw new Error(error.message);
    const title = 'Барбер вошёл вне рабочего места';
    const body = `Барбер ${barber?.name || 'Неизвестный барбер'} выполнил вход вне радиуса филиала ${branch?.name || branchId}.`;
    const rows = (recipients || []).filter(user => ['admin_network', 'admin', 'super-manager'].includes(user.role) || String(user.branch_id) === String(branchId));
    for (const recipient of rows) {
        await db.query(`
          insert into notifications (recipient_user_id, type, title, body, branch_id, data)
          values ($1, 'barber_location_warning', $2, $3, $4, $5::jsonb)
          on conflict do nothing
        `, [recipient.id, title, body, branchId, JSON.stringify({ barber_id: barberId, event_id: event?.id || null, distance_meters: event?.distance_meters || null })]);
    }
}

async function sendPushToUser(userId, payload) {
    if (!configureWebPush()) throw new Error('VAPID keys are not configured');
    const result = await db.query('select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1', [userId]);
    const summary = { found: result.rows.length, sent: 0, failed: 0, removed: 0 };
    await Promise.all(result.rows.map(async (subscription) => {
        try {
            await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(payload));
            summary.sent += 1;
        }
        catch (error) {
            const statusCode = Number(error?.statusCode || error?.status || 0);
            // Endpoints rejected by the push service are no longer usable.
            // Remove all client-side/authorization 4xx failures so a device
            // can register a fresh subscription after a VAPID-key rotation.
            if ([400, 401, 403, 404, 410].includes(statusCode)) {
                await db.query('delete from push_subscriptions where id = $1', [subscription.id]);
                summary.removed += 1;
                return;
            }
            summary.failed += 1;
            console.error('Push notification failed:', {
                message: error.message,
                statusCode: statusCode || null,
                body: error.body || error.response?.body || null,
            });
        }
    }));
    return summary;
}

function transferOutcomeCopy(status) {
    return status === 'accepted'
        ? { title: 'Запрос на смену барбера принят', body: 'Другой барбер принял клиента.' }
        : { title: 'Запрос на смену барбера отклонён', body: 'Другой барбер отклонил клиента.' };
}

async function sendQueueTransferPush({ userId, transferId, entryId, status, fromBarberId, toBarberId, branchId, reason, notificationId }) {
    const copy = transferOutcomeCopy(status);
    let tokens;
    try {
        const result = await db.query(
            'select token from employee_push_tokens where user_id = $1',
            [userId],
        );
        tokens = result.rows || [];
    } catch (_error) {
        console.warn('[queue-transfer-push] delivery skipped', { transferId, reason: 'token_lookup_failed' });
        return { delivered: 0, reason: 'token_lookup_failed' };
    }

    if (!tokens.length) {
        console.warn('[queue-transfer-push] delivery skipped', { transferId, reason: 'no_registered_tokens' });
        return { delivered: 0, reason: 'no_registered_tokens' };
    }

    let delivered = 0;
    for (const { token } of tokens) {
        try {
            const result = await marketplacePush.sendFcmNotification({
                token,
                ...copy,
                channelId: 'queue_transfer_outcomes',
                data: {
                    type: 'queue_transfer_outcome',
                    ...(notificationId ? { notification_id: notificationId } : {}),
                    transfer_id: transferId,
                    entry_id: entryId,
                    result: status,
                    from_barber_id: fromBarberId,
                    to_barber_id: toBarberId,
                    branch_id: branchId,
                    ...(reason ? { reason } : {}),
                },
            });
            if (result.delivered) {
                delivered += 1;
            } else {
                console.warn('[queue-transfer-push] delivery skipped', { transferId, reason: result.reason || 'provider_unavailable' });
            }
        } catch (error) {
            const code = String(error?.code || 'provider_error');
            if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code)) {
                await db.query(
                    'delete from employee_push_tokens where user_id = $1 and token = $2',
                    [userId, token],
                ).catch(() => {});
            }
            console.warn('[queue-transfer-push] delivery failed', { transferId, reason: code });
        }
    }

    return { delivered, reason: delivered ? null : 'delivery_failed' };
}

class Notifications {
    async saveFcmToken(req, res) {
        const payload = authenticate(req, res); if (!payload) return;
        const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
        const platform = String(req.body?.platform || '').trim().toUpperCase();
        if (!token || token.length > 4096 || !['ANDROID', 'IOS'].includes(platform)) {
            return res.status(400).json({ error: 'Valid token and platform are required' });
        }
        try {
            await db.query(`
                insert into employee_push_tokens (token, user_id, platform, updated_at)
                values ($1, $2, $3, now())
                on conflict (token) do update
                    set user_id = excluded.user_id,
                        platform = excluded.platform,
                        updated_at = now()
            `, [token, payload.sub || payload.id, platform]);
            return res.status(201).json({ registered: true });
        } catch (error) {
            return res.status(500).json({ error: 'Failed to register push token' });
        }
    }

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

    async removePushSubscription(req, res) {
        const payload = authenticate(req, res); if (!payload) return;
        const endpoint = String(req.body?.endpoint || '').trim();
        if (!endpoint) return res.status(400).json({ error: 'Push subscription endpoint is required' });
        try {
            const result = await db.query(
                'delete from push_subscriptions where user_id = $1 and endpoint = $2',
                [payload.sub || payload.id, endpoint]
            );
            return res.json({ success: true, removed: result.rowCount || 0 });
        }
        catch (error) { return res.status(500).json({ error: error.message }); }
    }

    async testPush(req, res) {
        const payload = authenticate(req, res); if (!payload) return;
        if (!configureWebPush()) return res.status(503).json({ error: 'VAPID keys are not configured' });
        try {
            const result = await sendPushToUser(payload.sub || payload.id, { title: 'Тестовое уведомление', body: 'Push работает на этом устройстве.', url: '/notifications', tag: 'test-push' });
            if (!result.found) return res.status(404).json({ error: 'No push subscriptions found for this user', ...result });
            if (!result.sent && result.removed && !result.failed) return res.status(410).json({ error: 'Push subscription expired; enable notifications again on this device', ...result });
            if (!result.sent) return res.status(502).json({ error: 'Push delivery failed', ...result });
            return res.json({ success: true, ...result });
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
module.exports = {
    notifications: new Notifications(),
    createSuspiciousOrderNotifications,
    createLocationWarningNotifications,
    sendQueueTransferPush,
    ensureNotificationsTable,
    _private: { normalizePersistedQualityAssessment, transferOutcomeCopy },
};
