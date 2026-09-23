const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../../config/postgres');

const MARKETPLACE_ROLE = 'marketplace';

const fallbackReferralCode = (seed) => {
  let hash = 0;
  for (const char of String(seed || '')) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `BR${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
};

const isMissingCashbackSchemaError = (error) => {
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();
  return code === '42P01' || code === '42703' || message.includes('cashback_transactions') || message.includes('cashback_wallets');
};

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
    `select id, phone, is_active
       from marketplace_clients where id = $1`,
    [clientId]
  );
  return result.rows[0]
    ? { ...result.rows[0], status_points: 0, blocked_until: null, cancel_count_today: 0 }
    : null;
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
      'branch_id', q.branch_id, 'barber_name', br.name,
      'queue_status', q.status,
      'queue_position', case when q.status in ('waiting', 'called', 'swapped', 'in_progress') then (
        select count(*)::int + 1
          from queue_entries q2
         where q2.barber_id = q.barber_id
           and q2.status in ('waiting', 'called', 'swapped', 'in_progress')
           and (q2.status = 'in_progress' or q2.created_at >= now() - interval '9 hours')
           and (q2.created_at < q.created_at or (q2.created_at = q.created_at and q2.id <= q.id))
      ) else null end,
      'estimated_wait_minutes', case when q.status in ('waiting', 'swapped') then (
        select coalesce(sum(
          case when q2.status = 'in_progress' and q2.started_at is not null
            then greatest(0, duration.total_minutes - floor(extract(epoch from (now() - q2.started_at)) / 60))
            else duration.total_minutes
          end
        ), 0)::int
          from queue_entries q2
          cross join lateral (
            select coalesce(sum(s.duration_minutes), 0)::int as total_minutes
              from services s
             where s.id = any(coalesce(q2.service_ids, array[q2.service_id]::uuid[]))
          ) duration
         where q2.barber_id = q.barber_id
           and q2.status in ('waiting', 'called', 'swapped', 'in_progress')
           and (q2.status = 'in_progress' or q2.created_at >= now() - interval '9 hours')
           and (q2.created_at < q.created_at or (q2.created_at = q.created_at and q2.id < q.id))
      ) else 0 end,
      'created_at', q.created_at, 'started_at', q.started_at,
      'service_ids', coalesce((select json_agg(ps.service_id order by ps.service_id) from marketplace_booking_person_services ps where ps.person_id = p.id), '[]'::json),
      'service_names', coalesce((select json_agg(s.name order by s.name)
          from marketplace_booking_person_services ps
          join services s on s.id = ps.service_id
         where ps.person_id = p.id), '[]'::json)
    ) order by p.person_index) filter (where p.id is not null), '[]'::json) as persons
     from marketplace_bookings b
     left join marketplace_booking_persons p on p.booking_id = b.id
     left join queue_entries q on q.id = p.queue_entry_id
     left join barbers br on br.id = p.barber_id
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
  try {
    const result = await pool.query(
      `select id, type, payload, read_at, created_at from marketplace_notifications
       where marketplace_client_id = $1 order by created_at desc limit $2`,
      [clientId, limit]
    );
    return res.json({ items: result.rows });
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') {
      return res.json({ items: [], available: false });
    }
    throw error;
  }
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
  if (!token || token.length > 2048 || !['ANDROID', 'IOS', 'WEB'].includes(platform)) {
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
  try {
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
              coalesce(mc.email, mc.phone) as referred_name,
              coalesce(sum(rt.amount), 0) as earned
         from referrals r
         join marketplace_clients mc on mc.id = r.referred_client_id
         left join referral_transactions rt on rt.referral_id = r.id
        where r.referrer_client_id = $1
        group by r.id, mc.email, mc.phone
        order by r.created_at desc`, [clientId]
    );
    return res.json({ referral_code: result.rows[0].referral_code, bonus_balance: Number(balance.rows[0]?.referral_bonus_balance || 0), invited: invited.rows });
  } catch (error) {
    // The compliance migration may not yet be applied on an older database.
    // Keep the mobile screen usable and expose an explicit unavailable state.
    if (error?.code === '42P01' || error?.code === '42703') {
      const client = await pool.query(
        'select email from marketplace_clients where id = $1',
        [clientId],
      );
      return res.json({
        referral_code: fallbackReferralCode(client.rows[0]?.email || clientId),
        bonus_balance: 0,
        invited: [],
        available: false,
        warning: 'Referral migration is not applied yet',
      });
    }
    throw error;
  }
}

async function createReview(req, res) {
  const clientId = authClient(req, res);
  if (!clientId) return;
  const requestId = String(req.body?.request_id || req.get('Idempotency-Key') || '').trim() || null;
  const bookingId = String(req.body?.booking_id || '').trim();
  const rating = Number(req.body?.rating);
  const comment = req.body?.comment == null ? null : String(req.body.comment).trim();
  if (!bookingId || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'booking_id and rating from 1 to 5 are required' });
  }
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    let idempotencyAvailable = Boolean(requestId);
    if (requestId) {
      try {
        const prior = await dbClient.query(
          `select status, response, payload_hash from marketplace_idempotency_requests
            where request_id = $1 and marketplace_client_id = $2 for update`, [requestId, clientId]
        );
        const reviewPayloadHash = crypto.createHash('md5').update(JSON.stringify(req.body || {})).digest('hex');
        if (prior.rows[0]?.payload_hash && prior.rows[0].payload_hash !== reviewPayloadHash) {
          await dbClient.query('ROLLBACK');
          return res.status(409).json({ error: 'IDEMPOTENCY_KEY_REUSED' });
        }
        if (prior.rows[0]?.response) {
          await dbClient.query('ROLLBACK');
          return res.status(Number(prior.rows[0].status || 201)).json(prior.rows[0].response);
        }
        if (prior.rows[0]) {
          await dbClient.query('ROLLBACK');
          return res.status(409).json({ error: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' });
        }
        await dbClient.query(
          `insert into marketplace_idempotency_requests (request_id, marketplace_client_id, operation, payload_hash)
           values ($1, $2, 'REVIEW_CREATE', md5($3))`,
          [requestId, clientId, JSON.stringify(req.body || {})]
        );
      } catch (error) {
        if (error?.code !== '42P01') throw error;
        // Older production databases may have reviews but not the optional
        // idempotency table yet. Keep review submission working; the table is
        // still created by marketplace_tz_compliance.sql when migrations run.
        // PostgreSQL marks the current transaction as aborted after the
        // missing-relation error, so start a clean transaction before the
        // review queries continue.
        await dbClient.query('ROLLBACK');
        await dbClient.query('BEGIN');
        idempotencyAvailable = false;
        console.warn('[MarketplaceCompliance] idempotency table is unavailable; creating review without deduplication');
      }
    }
    const booking = await dbClient.query(
      `select id from marketplace_bookings
        where marketplace_client_id = $2 and status = 'COMPLETED'
          and (id = $1 or exists (
            select 1 from marketplace_booking_persons bp
             where bp.booking_id = marketplace_bookings.id and bp.queue_entry_id = $1
          ))`, [bookingId, clientId]
    );
    let resolvedBookingId = booking.rows[0]?.id;
    if (!resolvedBookingId) {
      // Older completed marketplace visits may exist only as queue_entries.
      // Backfill the aggregate booking lazily when the client submits its
      // first review, so the review remains compatible with legacy history.
      const legacyQueueEntry = await dbClient.query(
        `select q.id, q.barber_id, c.name as client_name
           from queue_entries q
           join clients c on c.id = q.client_id
           join marketplace_clients mc on mc.phone = c.phone
          where q.id = $1
            and mc.id = $2
            and q.source = 'site'
            and q.status = 'completed'
          limit 1`,
        [bookingId, clientId],
      );
      if (legacyQueueEntry.rows[0]) {
        const legacy = legacyQueueEntry.rows[0];
        const createdBooking = await dbClient.query(
          `insert into marketplace_bookings
             (marketplace_client_id, source, status)
           values ($1, 'MARKETPLACE', 'COMPLETED')
           returning id`,
          [clientId],
        );
        resolvedBookingId = createdBooking.rows[0].id;
        await dbClient.query(
          `insert into marketplace_booking_persons
             (booking_id, person_index, display_name, barber_id, queue_entry_id)
           values ($1, 1, $2, $3, $4)`,
          [
            resolvedBookingId,
            legacy.client_name || 'Client',
            legacy.barber_id,
            legacy.id,
          ],
        );
      }
    }
    if (!resolvedBookingId) {
      await dbClient.query('ROLLBACK');
      return res.status(409).json({ error: 'REVIEW_NOT_ALLOWED' });
    }
    const result = await dbClient.query(
      `insert into marketplace_reviews (marketplace_client_id, booking_id, rating, comment)
       values ($1, $2, $3, $4) returning *`,
      [clientId, resolvedBookingId, rating, comment]
    );
    await dbClient.query(
      `insert into marketplace_audit_logs (marketplace_client_id, action, entity_type, entity_id, metadata)
       values ($1, 'REVIEW_CREATED', 'marketplace_booking', $2, $3::jsonb)`,
      [clientId, resolvedBookingId, JSON.stringify({ rating })]
    );
    const response = { review: result.rows[0] };
    if (requestId && idempotencyAvailable) {
      await dbClient.query(
        `update marketplace_idempotency_requests set status = 201, response = $2::jsonb, completed_at = now() where request_id = $1`,
        [requestId, JSON.stringify(response)]
      );
    }
    await dbClient.query('COMMIT');
    return res.status(201).json(response);
  } catch (error) {
    try { await dbClient.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (error.code === '23505') return res.status(409).json({ error: 'Review already exists' });
    throw error;
  } finally {
    dbClient.release();
  }
}

async function cancelBooking(req, res) {
  const clientId = authClient(req, res);
  if (!clientId) return;
  const bookingId = String(req.params.id || '').trim();
  const requestId = String(req.body?.request_id || req.get('Idempotency-Key') || '').trim() || null;
  const settings = await getPlatformSetting('anti_fraud', { cancel_cooldown_minutes: 15, cancel_block_threshold: 3, block_hours: 24 });
  const client = await getClient(clientId);
  if (!client) return res.status(404).json({ error: 'Marketplace client not found' });
  if (client.blocked_until && new Date(client.blocked_until) > new Date()) return res.status(403).json({ error: 'ACCOUNT_BLOCKED' });

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const lockedClientResult = await dbClient.query(
      `select id, phone, status_points, blocked_until,
              case when cancel_count_date = (now() at time zone 'Asia/Tashkent')::date then cancel_count_today else 0 end as cancel_count_today,
              is_active
         from marketplace_clients
        where id = $1
        for update`,
      [clientId]
    );
    const lockedClient = lockedClientResult.rows[0];
    if (!lockedClient) {
      await dbClient.query('ROLLBACK');
      return res.status(404).json({ error: 'Marketplace client not found' });
    }
    if (lockedClient.is_active === false || (lockedClient.blocked_until && new Date(lockedClient.blocked_until) > new Date())) {
      await dbClient.query('ROLLBACK');
      return res.status(403).json({ error: 'ACCOUNT_BLOCKED' });
    }
    if (requestId) {
      const prior = await dbClient.query(
        `select status, response, payload_hash from marketplace_idempotency_requests
          where request_id = $1 and marketplace_client_id = $2 for update`, [requestId, clientId]
      );
      const cancelPayloadHash = crypto.createHash('md5').update(JSON.stringify(req.body || {})).digest('hex');
      if (prior.rows[0]?.payload_hash && prior.rows[0].payload_hash !== cancelPayloadHash) {
        await dbClient.query('ROLLBACK');
        return res.status(409).json({ error: 'IDEMPOTENCY_KEY_REUSED' });
      }
      if (prior.rows[0]?.response) {
        await dbClient.query('ROLLBACK');
        return res.status(Number(prior.rows[0].status || 200)).json(prior.rows[0].response);
      }
      if (prior.rows[0]) {
        await dbClient.query('ROLLBACK');
        return res.status(409).json({ error: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' });
      }
      await dbClient.query(
        `insert into marketplace_idempotency_requests (request_id, marketplace_client_id, operation, payload_hash)
         values ($1, $2, 'BOOKING_CANCEL', md5($3))`,
        [requestId, clientId, JSON.stringify(req.body || {})]
      );
    }
    const bookingResult = await dbClient.query(
      `select b.*,
              exists (
                select 1
                  from marketplace_booking_persons bp
                  join queue_entries q on q.id = bp.queue_entry_id
                 where bp.booking_id = b.id and q.status = 'in_progress'
              ) as has_in_progress_person
         from marketplace_bookings b
        where b.marketplace_client_id = $2 and b.status = 'ACTIVE'
          and (b.id = $1 or exists (
            select 1 from marketplace_booking_persons bp
             where bp.booking_id = b.id and bp.queue_entry_id = $1
          ))
         for update`,
      [bookingId, clientId]
    );
    const booking = bookingResult.rows[0];
    if (!booking) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'BOOKING_NOT_FOUND' }); }
    if (booking.has_in_progress_person) {
      await dbClient.query('ROLLBACK');
      return res.status(409).json({ error: 'BOOKING_NOT_CANCELLABLE' });
    }
    const resolvedBookingId = booking.id;
    const now = new Date();
    const cooldownUntil = new Date(now.getTime() + Number(settings.cancel_cooldown_minutes || 15) * 60000);
    const cancelCount = Number(lockedClient.cancel_count_today || 0) + 1;
    const blockedUntil = cancelCount >= Number(settings.cancel_block_threshold || 3)
      ? new Date(now.getTime() + Number(settings.block_hours || 24) * 3600000)
      : null;
    await dbClient.query(
      `update marketplace_bookings set status = 'CANCELLED', cancelled_at = now(), cooldown_until = $1, cancel_count = cancel_count + 1, updated_at = now() where id = $2`,
      [cooldownUntil.toISOString(), resolvedBookingId]
    );
    const queueEntries = await dbClient.query(
      `select p.queue_entry_id, q.branch_id, q.client_id
         from marketplace_booking_persons p
         join queue_entries q on q.id = p.queue_entry_id
        where p.booking_id = $1
        for update`, [resolvedBookingId]
    );
    await dbClient.query(
      `update queue_entries q
          set status = 'cancelled', finished_at = now(), updated_at = now()
        where q.id in (select queue_entry_id from marketplace_booking_persons where booking_id = $1)
           and q.status in ('waiting', 'called', 'swapped')`, [resolvedBookingId]
    );
    let cashbackRefunded = 0;
    await dbClient.query('SAVEPOINT marketplace_cashback_refund');
    try {
      for (const queueEntry of queueEntries.rows) {
        const spent = await dbClient.query(
          `select id, client_id, amount
             from cashback_transactions
            where queue_entry_id = $1 and client_id = $2 and kind = 'spend'
            for update`,
          [queueEntry.queue_entry_id, queueEntry.client_id],
        );
        for (const transaction of spent.rows) {
          const reversal = await dbClient.query(
            `insert into cashback_transactions
              (client_id, queue_entry_id, kind, amount, reversal_of, meta)
             values ($1, $2, 'adjust', $3, $4, $5::jsonb)
             on conflict (reversal_of, kind) where reversal_of is not null do nothing
             returning amount`,
            [
              transaction.client_id,
              queueEntry.queue_entry_id,
              transaction.amount,
              transaction.id,
              JSON.stringify({ type: 'booking_cancel_refund', booking_id: resolvedBookingId }),
            ],
          );
          if (!reversal.rows[0]) continue;
          const walletUpdate = await dbClient.query(
            `update cashback_wallets
                set balance = round((balance + $2)::numeric, 2), updated_at = now()
              where client_id = $1`,
            [transaction.client_id, reversal.rows[0].amount],
          );
          if (walletUpdate.rowCount !== 1) {
            throw new Error('Cashback wallet is missing for reversal');
          }
          cashbackRefunded += Number(reversal.rows[0].amount || 0);
        }
      }
      await dbClient.query('RELEASE SAVEPOINT marketplace_cashback_refund');
    } catch (cashbackError) {
      await dbClient.query('ROLLBACK TO SAVEPOINT marketplace_cashback_refund');
      // Keep cancellation compatible with legacy deployments without the
      // cashback ledger tables.
      if (!isMissingCashbackSchemaError(cashbackError)) throw cashbackError;
      cashbackRefunded = 0;
    }
    await dbClient.query(
      `insert into marketplace_notifications (marketplace_client_id, type, payload)
       values ($1, 'BOOKING_CANCELLED', $2::jsonb)`,
      [clientId, JSON.stringify({ booking_id: resolvedBookingId })]
    );
    const lateCancel = booking.scheduled_start_at &&
      new Date(booking.scheduled_start_at).getTime() - now.getTime() <= 30 * 60000;
    if (lateCancel) {
      const pointsConfig = await dbClient.query(
        `select value from platform_settings where key = 'status_points'`
      );
      const oldLevelResult = await dbClient.query(
        `select marketplace_loyalty_level(status_points) as level
           from marketplace_clients where id = $1`,
        [clientId],
      );
      const oldLevel = oldLevelResult.rows[0]?.level || null;
      const penalty = Math.min(-1, Number(pointsConfig.rows[0]?.value?.late_cancel_penalty ?? -10));
      const insertedPenalty = await dbClient.query(
        `insert into status_point_transactions (marketplace_client_id, booking_id, kind, amount, reason)
         values ($1, $2, 'PENALTY', $3, 'LATE_CANCEL') on conflict (booking_id, kind) where booking_id is not null do nothing returning id`,
        [clientId, resolvedBookingId, penalty]
      );
      if (insertedPenalty.rows[0]) {
        await dbClient.query(
          `update marketplace_clients set status_points = greatest(0, status_points + $1) where id = $2`,
          [penalty, clientId]
        );
        const newLevelResult = await dbClient.query(
          `select marketplace_loyalty_level(status_points) as level
             from marketplace_clients where id = $1`,
          [clientId],
        );
        const newLevel = newLevelResult.rows[0]?.level || null;
        if (oldLevel && newLevel && oldLevel !== newLevel) {
          await dbClient.query(
            `insert into marketplace_notifications (marketplace_client_id, type, payload)
             values ($1, 'LEVEL_CHANGED', $2::jsonb)`,
            [clientId, JSON.stringify({ old_level: oldLevel, new_level: newLevel, reason: 'LATE_CANCEL' })],
          );
        }
      }
    }
    await dbClient.query(
      `update marketplace_clients set cancel_count_today = $1, cancel_count_date = (now() at time zone 'Asia/Tashkent')::date, blocked_until = $2 where id = $3`,
      [cancelCount, blockedUntil?.toISOString() || null, clientId]
    );
    if (blockedUntil) {
      await dbClient.query(
        `insert into marketplace_notifications (marketplace_client_id, type, payload)
         values ($1, 'ACCOUNT_BLOCKED_CANCELS', $2::jsonb)`,
        [clientId, JSON.stringify({ blocked_until: blockedUntil.toISOString(), reason: 'CANCEL_LIMIT' })]
      );
    }
    await dbClient.query(
      `insert into marketplace_audit_logs (marketplace_client_id, action, entity_type, entity_id, metadata)
       values ($1, 'BOOKING_CANCELLED', 'marketplace_booking', $2, $3::jsonb)`,
      [clientId, resolvedBookingId, JSON.stringify({
        late_cancel: Boolean(lateCancel),
        cancel_count: cancelCount,
        cashback_refunded: cashbackRefunded,
      })]
    );
    const response = {
      cancelled: true,
      booking_id: resolvedBookingId,
      cooldown_until: cooldownUntil.toISOString(),
      blocked_until: blockedUntil?.toISOString() || null,
      cashback_refunded: Number(cashbackRefunded.toFixed(2)),
    };
    if (requestId) {
      await dbClient.query(
        `update marketplace_idempotency_requests set status = 200, response = $2::jsonb, completed_at = now() where request_id = $1`,
        [requestId, JSON.stringify(response)]
      );
    }
    await dbClient.query('COMMIT');
    const io = req.app.get('io');
    if (io) {
      const branches = new Set(queueEntries.rows.map((row) => row.branch_id).filter(Boolean));
      for (const branchId of branches) {
        const payload = {
          type: 'queue_cancelled',
          branchId,
          bookingId: resolvedBookingId,
          queueEntryIds: queueEntries.rows.map((row) => row.queue_entry_id).filter(Boolean),
        };
        const room = io.to(`branch:${branchId}`);
        room.emit('queue:update', payload);
        room.emit('booking.cancelled', { ...payload, type: 'booking_cancelled' });
      }
    }
    return res.json(response);
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
