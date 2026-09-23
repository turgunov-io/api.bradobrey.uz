const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../../config/postgres');

const MARKETPLACE_ROLE = 'marketplace';

function authClient(req, res) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (payload?.role !== MARKETPLACE_ROLE || !(payload.sub || payload.id)) {
      res.status(403).json({ error: 'Only marketplace users can access this resource' });
      return null;
    }
    return String(payload.sub || payload.id);
  } catch (_) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
}

async function getClient(clientId) {
  const result = await pool.query(
    `select id, phone, display_name, status_points, blocked_until, is_active,
            case when cancel_count_date = current_date then cancel_count_today else 0 end as cancel_count_today
       from marketplace_clients where id = $1`,
    [clientId]
  );
  return result.rows[0] || null;
}

async function getPlatformSetting(key, fallback) {
  const result = await pool.query('select value from platform_settings where key = $1', [key]);
  return result.rows[0]?.value || fallback;
}

async function activeBooking(req, res) {
  const clientId = authClient(req, res);
  if (!clientId) return;
  const result = await pool.query(
    `select b.*, coalesce(json_agg(json_build_object(
      'id', p.id, 'person_index', p.person_index, 'display_name', p.display_name,
      'barber_id', p.barber_id, 'queue_entry_id', p.queue_entry_id,
      'service_ids', coalesce((select json_agg(ps.service_id) from marketplace_booking_person_services ps where ps.person_id = p.id), '[]'::json)
    ) order by p.person_index) filter (where p.id is not null), '[]'::json) as persons
     from marketplace_bookings b
     left join marketplace_booking_persons p on p.booking_id = b.id
     where b.marketplace_client_id = $1 and b.status = 'ACTIVE'
     group by b.id limit 1`,
    [clientId]
  );
  return res.json({ booking: result.rows[0] || null });
}

async function notifications(req, res) {
  const clientId = authClient(req, res);
  if (!clientId) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const result = await pool.query(
    `select id, type, payload, read_at, created_at from marketplace_notifications
     where marketplace_client_id = $1 order by created_at desc limit $2`,
    [clientId, limit]
  );
  return res.json({ items: result.rows });
}

async function markNotificationRead(req, res) {
  const clientId = authClient(req, res);
  if (!clientId) return;
  const result = await pool.query(
    `update marketplace_notifications set read_at = coalesce(read_at, now())
     where id = $1 and marketplace_client_id = $2 returning id, read_at`,
    [String(req.params.id || ''), clientId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Notification not found' });
  return res.json({ notification: result.rows[0] });
}

async function registerPushToken(req, res) {
  const clientId = authClient(req, res);
  if (!clientId) return;
  const token = String(req.body?.token || '').trim();
  const platform = String(req.body?.platform || '').trim().toUpperCase();
  if (!token || !['ANDROID', 'IOS', 'WEB'].includes(platform)) {
    return res.status(400).json({ error: 'token and platform are required' });
  }
  await pool.query(
    `insert into marketplace_push_tokens (marketplace_client_id, token, platform, last_seen_at)
     values ($1, $2, $3, now()) on conflict (marketplace_client_id, token)
     do update set platform = excluded.platform, last_seen_at = now()`,
    [clientId, token, platform]
  );
  return res.status(201).json({ registered: true });
}

async function loyalty(req, res) {
  const clientId = authClient(req, res);
  if (!clientId) return;
  const client = await getClient(clientId);
  if (!client) return res.status(404).json({ error: 'Marketplace client not found' });
  const settings = await getPlatformSetting('loyalty_levels', {});
  const points = Number(client.status_points || 0);
  const levels = Object.entries(settings)
    .map(([name, value]) => ({ name, min_points: Number(value.min_points || 0), cashback_percent: Number(value.cashback_percent || 0) }))
    .sort((a, b) => a.min_points - b.min_points);
  const current = levels.filter((level) => points >= level.min_points).at(-1) || levels[0] || { name: 'NONE', min_points: 0, cashback_percent: 0 };
  const next = levels.find((level) => level.min_points > points) || null;
  return res.json({ status_points: points, level: current, next_level: next, blocked_until: client.blocked_until || null });
}

async function referral(req, res) {
  const clientId = authClient(req, res);
  if (!clientId) return;
  const code = `BR${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const result = await pool.query(
    `insert into referral_accounts (marketplace_client_id, referral_code) values ($1, $2)
     on conflict (marketplace_client_id) do update set referral_code = referral_accounts.referral_code
     returning referral_code`,
    [clientId, code]
  );
  const balance = await pool.query(
    `select referral_bonus_balance from marketplace_clients where id = $1`, [clientId]
  );
  const invited = await pool.query(
    `select r.id, r.expires_at, r.activated_at, r.created_at,
            coalesce(mc.display_name, mc.phone) as referred_name,
            coalesce(sum(rt.amount), 0) as earned
       from referrals r
       join marketplace_clients mc on mc.id = r.referred_client_id
       left join referral_transactions rt on rt.referral_id = r.id
      where r.referrer_client_id = $1
      group by r.id, mc.display_name, mc.phone
      order by r.created_at desc`, [clientId]
  );
  return res.json({ referral_code: result.rows[0].referral_code, bonus_balance: Number(balance.rows[0]?.referral_bonus_balance || 0), invited: invited.rows });
}

async function createReview(req, res) {
  const clientId = authClient(req, res);
  if (!clientId) return;
  const bookingId = String(req.body?.booking_id || '').trim();
  const rating = Number(req.body?.rating);
  const comment = req.body?.comment == null ? null : String(req.body.comment).trim();
  if (!bookingId || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'booking_id and rating from 1 to 5 are required' });
  }
  const booking = await pool.query(
    `select id from marketplace_bookings where id = $1 and marketplace_client_id = $2 and status = 'COMPLETED'`,
    [bookingId, clientId]
  );
  if (!booking.rows[0]) return res.status(409).json({ error: 'REVIEW_NOT_ALLOWED' });
  try {
    const result = await pool.query(
      `insert into marketplace_reviews (marketplace_client_id, booking_id, rating, comment)
       values ($1, $2, $3, $4) returning *`,
      [clientId, bookingId, rating, comment]
    );
    await pool.query(
      `insert into marketplace_audit_logs (marketplace_client_id, action, entity_type, entity_id, metadata)
       values ($1, 'REVIEW_CREATED', 'marketplace_booking', $2, $3::jsonb)`,
      [clientId, bookingId, JSON.stringify({ rating })]
    );
    return res.status(201).json({ review: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Review already exists' });
    throw error;
  }
}

async function cancelBooking(req, res) {
  const clientId = authClient(req, res);
  if (!clientId) return;
  const bookingId = String(req.params.id || '').trim();
  const settings = await getPlatformSetting('anti_fraud', { cancel_cooldown_minutes: 15, cancel_block_threshold: 3, block_hours: 24 });
  const client = await getClient(clientId);
  if (!client) return res.status(404).json({ error: 'Marketplace client not found' });
  if (client.blocked_until && new Date(client.blocked_until) > new Date()) return res.status(403).json({ error: 'ACCOUNT_BLOCKED' });

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const bookingResult = await dbClient.query(
      `select * from marketplace_bookings where id = $1 and marketplace_client_id = $2 and status = 'ACTIVE' for update`,
      [bookingId, clientId]
    );
    const booking = bookingResult.rows[0];
    if (!booking) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'BOOKING_NOT_FOUND' }); }
    const now = new Date();
    const cooldownUntil = new Date(now.getTime() + Number(settings.cancel_cooldown_minutes || 15) * 60000);
    const cancelCount = Number(client.cancel_count_today || 0) + 1;
    const blockedUntil = cancelCount >= Number(settings.cancel_block_threshold || 3)
      ? new Date(now.getTime() + Number(settings.block_hours || 24) * 3600000)
      : null;
    await dbClient.query(
      `update marketplace_bookings set status = 'CANCELLED', cancelled_at = now(), cooldown_until = $1, cancel_count = cancel_count + 1, updated_at = now() where id = $2`,
      [cooldownUntil.toISOString(), bookingId]
    );
    await dbClient.query(
      `insert into marketplace_notifications (marketplace_client_id, type, payload)
       values ($1, 'BOOKING_CANCELLED', $2::jsonb)`,
      [clientId, JSON.stringify({ booking_id: bookingId })]
    );
    const lateCancel = booking.scheduled_start_at &&
      new Date(booking.scheduled_start_at).getTime() - now.getTime() <= 30 * 60000;
    if (lateCancel) {
      const pointsConfig = await dbClient.query(
        `select value from platform_settings where key = 'status_points'`
      );
      const penalty = Math.min(-1, Number(pointsConfig.rows[0]?.value?.late_cancel_penalty ?? -10));
      const insertedPenalty = await dbClient.query(
        `insert into status_point_transactions (marketplace_client_id, booking_id, kind, amount, reason)
         values ($1, $2, 'PENALTY', $3, 'LATE_CANCEL') on conflict (booking_id, kind) where booking_id is not null do nothing returning id`,
        [clientId, bookingId, penalty]
      );
      if (insertedPenalty.rows[0]) {
        await dbClient.query(
          `update marketplace_clients set status_points = greatest(0, status_points + $1) where id = $2`,
          [penalty, clientId]
        );
      }
    }
    await dbClient.query(
      `update marketplace_clients set cancel_count_today = $1, cancel_count_date = current_date, blocked_until = $2 where id = $3`,
      [cancelCount, blockedUntil?.toISOString() || null, clientId]
    );
    await dbClient.query(
      `insert into marketplace_audit_logs (marketplace_client_id, action, entity_type, entity_id, metadata)
       values ($1, 'BOOKING_CANCELLED', 'marketplace_booking', $2, $3::jsonb)`,
      [clientId, bookingId, JSON.stringify({ late_cancel: Boolean(lateCancel), cancel_count: cancelCount })]
    );
    await dbClient.query('COMMIT');
    return res.json({ cancelled: true, cooldown_until: cooldownUntil.toISOString(), blocked_until: blockedUntil?.toISOString() || null });
  } catch (error) {
    try { await dbClient.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    dbClient.release();
  }
}

module.exports = {
  activeBooking,
  loyalty,
  referral,
  createReview,
  cancelBooking,
  notifications,
  markNotificationRead,
  registerPushToken,
};
