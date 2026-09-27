const { pool } = require('../config/postgres');

async function creditReferralToCashbackWallet(client, { referralTransactionId, referrerClientId, amount, bookingId, queueEntryId }) {
  const referrer = await client.query(
    `select phone, coalesce(nullif(display_name, ''), 'Client') as display_name
       from marketplace_clients
      where id = $1
      for update`,
    [referrerClientId],
  );
  const phone = referrer.rows[0]?.phone;
  if (!phone) throw new Error('Referrer phone is required for cashback wallet');

  const existingLegacyClient = await client.query(
    `select id
       from clients
      where regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') =
            regexp_replace($1, '[^0-9]', '', 'g')
      order by (phone = $1) desc, id
      limit 1
      for update`,
    [phone],
  );
  const legacyClientId = existingLegacyClient.rows[0]?.id || (
    await client.query(
      `insert into clients (name, phone)
       values ($1, $2)
       on conflict (phone) do update set name = coalesce(nullif(clients.name, ''), excluded.name)
       returning id`,
      [referrer.rows[0].display_name, phone],
    )
  ).rows[0]?.id;
  if (!legacyClientId) throw new Error('Unable to resolve referrer cashback wallet');

  const requestId = `referral_bonus:${referralTransactionId}`;
  const walletTransaction = await client.query(
    `insert into cashback_transactions
      (client_id, kind, amount, meta, request_id)
      values ($1, 'adjust', $2, $3::jsonb, $4)
     on conflict (request_id) where request_id is not null do nothing
     returning id`,
    [legacyClientId, amount, JSON.stringify({ source: 'referral_bonus', description: 'Реферальный бонус', booking_id: bookingId, queue_entry_id: queueEntryId || null, referral_transaction_id: referralTransactionId }), requestId],
  );
  if (!walletTransaction.rows[0]) return false;

  await client.query(
    `insert into cashback_wallets (client_id, balance)
     values ($1, $2)
     on conflict (client_id) do update
       set balance = round((cashback_wallets.balance + excluded.balance)::numeric, 2), updated_at = now()`,
    [legacyClientId, amount],
  );
  return true;
}

async function backfillReferralWallets(client, { limit = 100 } = {}) {
  const result = await client.query(
      `select rt.id as referral_transaction_id, rt.booking_id, rt.queue_entry_id, rt.amount,
            r.referrer_client_id
       from referral_transactions rt
       join referrals r on r.id = rt.referral_id
      where not exists (
        select 1 from cashback_transactions ct
         where ct.request_id = 'referral_bonus:' || rt.id::text
      )
      order by rt.created_at asc
      limit $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)],
  );
  let credited = 0;
  for (const row of result.rows) {
    if (await creditReferralToCashbackWallet(client, row)) credited += 1;
  }
  return credited;
}

async function awardFirstVisitReferralPoints(client, { limit = 100 } = {}) {
  const referrals = await client.query(
    `select r.id as referral_id, r.referrer_client_id, first_visit.booking_id,
            first_visit.queue_entry_id,
            coalesce((select (value ->> 'referral_points')::integer from platform_settings where key = 'status_points'), 15) as points
       from referrals r
       join lateral (
         select b.id as booking_id, q.id as queue_entry_id
           from marketplace_bookings b
           join marketplace_booking_persons bp on bp.booking_id = b.id
           join queue_entries q on q.id = bp.queue_entry_id
          where b.marketplace_client_id = r.referred_client_id and q.status = 'completed'
          order by q.created_at, q.id limit 1
       ) first_visit on true
      where r.expires_at > now()
        and not exists (select 1 from status_point_transactions spt
                         where spt.request_id = 'referral_first_visit:' || r.id::text)
      order by first_visit.queue_entry_id
      limit $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)],
  );
  let awarded = 0;
  for (const row of referrals.rows) {
    const points = Math.max(0, Number(row.points) || 0);
    if (!points) continue;
    await client.query('select id from marketplace_clients where id = $1 for update', [row.referrer_client_id]);
    const cap = await client.query(
      `select coalesce((value ->> 'daily_positive_limit')::integer, 20) as daily_limit
         from platform_settings where key = 'status_points'`,
    );
    const earned = await client.query(
      `select coalesce(sum(amount), 0) as total from status_point_transactions
        where marketplace_client_id = $1 and amount > 0
          and (created_at at time zone 'Asia/Tashkent')::date = (now() at time zone 'Asia/Tashkent')::date`,
      [row.referrer_client_id],
    );
    if (Number(earned.rows[0]?.total || 0) + points > Number(cap.rows[0]?.daily_limit ?? 20)) continue;
    const oldClient = await client.query(
      `select status_points, marketplace_loyalty_level(status_points) as old_level
         from marketplace_clients where id = $1`,
      [row.referrer_client_id],
    );
    const insertion = await client.query(
      `insert into status_point_transactions
        (marketplace_client_id, kind, amount, reason, request_id, metadata)
       values ($1, 'EARN', $2, 'REFERRAL_FIRST_VISIT', $3, $4::jsonb)
       on conflict (request_id) where request_id is not null do nothing returning id`,
      [row.referrer_client_id, points, `referral_first_visit:${row.referral_id}`,
        JSON.stringify({ referral_id: row.referral_id, booking_id: row.booking_id, queue_entry_id: row.queue_entry_id })],
    );
    if (!insertion.rows[0]) continue;
    const updated = await client.query(
      `update marketplace_clients set status_points = status_points + $2
        where id = $1 returning status_points, marketplace_loyalty_level(status_points) as new_level`,
      [row.referrer_client_id, points],
    );
    if (oldClient.rows[0]?.old_level !== updated.rows[0]?.new_level) {
      await client.query(
        `insert into marketplace_notifications (marketplace_client_id, type, payload)
         values ($1, 'LEVEL_CHANGED', $2::jsonb)`,
        [row.referrer_client_id, JSON.stringify({ old_level: oldClient.rows[0]?.old_level, new_level: updated.rows[0]?.new_level })],
      );
    }
    awarded += 1;
  }
  return awarded;
}

async function settlePendingReferralBonuses({ limit = 100, referrerClientId = null } = {}) {
  const client = await pool.connect();
  let settled = 0;
  try {
    await client.query('BEGIN');
    const params = [Math.min(Math.max(Number(limit) || 100, 1), 500)];
    const referrerFilter = referrerClientId
      ? 'and r.referrer_client_id = $2'
      : '';
    if (referrerClientId) params.push(referrerClientId);
    const candidates = await client.query(
      `select r.id as referral_id, r.referrer_client_id,
              linked_booking.booking_id, q.id as queue_entry_id,
              round((
                coalesce(sum(pay.amount) filter (where pay.method in ('payme', 'click', 'cash', 'card')), 0)
                + coalesce(sum(
                    case
                      when pay.id is null and q.payment_method in ('payme', 'click', 'cash', 'card') then
                        coalesce(
                          q.price_override,
                          (select sum(s.base_price) from services s where s.id = any(q.service_ids)),
                          (select s.base_price from services s where s.id = q.service_id),
                          0
                        )
                      else 0
                    end
                  ), 0)
              )::numeric, 2) as paid_money,
              coalesce((select (value ->> 'bonus_percent')::numeric
                          from platform_settings where key = 'referral'), 1) as bonus_percent
         from referrals r
         join marketplace_clients referred_mc
           on referred_mc.id = r.referred_client_id
         join clients referred_c
           on regexp_replace(coalesce(referred_c.phone, ''), '[^0-9]', '', 'g') =
              regexp_replace(coalesce(referred_mc.phone, ''), '[^0-9]', '', 'g')
          and regexp_replace(coalesce(referred_mc.phone, ''), '[^0-9]', '', 'g') <> ''
         join queue_entries q
           on q.client_id = referred_c.id
          and q.status = 'completed'
         left join lateral (
           select bp.booking_id
             from marketplace_booking_persons bp
            where bp.queue_entry_id = q.id
            order by bp.booking_id
            limit 1
         ) linked_booking on true
         left join payments pay on pay.queue_entry_id = q.id
        where r.expires_at > now()
          ${referrerFilter}
          and not exists (
            select 1 from referral_transactions rt
             where rt.referral_id = r.id and rt.queue_entry_id = q.id
          )
        group by r.id, r.referrer_client_id, linked_booking.booking_id, q.id
        order by q.updated_at asc
        limit $1`,
      params,
    );

    for (const row of candidates.rows) {
      const paidMoney = Number(row.paid_money || 0);
      // Referral rewards are whole cashback points: 1 point equals 1 sum.
      const bonus = Math.floor(paidMoney * Number(row.bonus_percent || 1) / 100);
      if (paidMoney <= 0 || bonus <= 0) continue;

      const inserted = await client.query(
        `insert into referral_transactions
          (referral_id, booking_id, queue_entry_id, amount, paid_with_money)
         values ($1, $2, $3, $4, $5)
         on conflict (referral_id, queue_entry_id) where queue_entry_id is not null do nothing
         returning id`,
        [row.referral_id, row.booking_id, row.queue_entry_id, bonus, paidMoney],
      );
      if (!inserted.rows[0]) continue;

      await client.query(
        `insert into marketplace_notifications (marketplace_client_id, type, payload)
         values ($1, 'REFERRAL_BONUS', $2::jsonb)`,
        [row.referrer_client_id, JSON.stringify({ amount: bonus, booking_id: row.booking_id })],
      );
      await creditReferralToCashbackWallet(client, {
        referralTransactionId: inserted.rows[0].id,
        referrerClientId: row.referrer_client_id,
        amount: bonus,
        bookingId: row.booking_id,
        queueEntryId: row.queue_entry_id,
      });
      settled += 1;
    }
    const referralPointsAwarded = await awardFirstVisitReferralPoints(client, { limit });
    await backfillReferralWallets(client, { limit: 100 });
    await client.query('COMMIT');
    return { settled, referralPointsAwarded };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* no-op */ }
    throw error;
  } finally {
    client.release();
  }
}

function startReferralBonusScheduler() {
  const intervalMs = Math.max(Number(process.env.REFERRAL_BONUS_POLL_MS || 300000), 60000);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await settlePendingReferralBonuses();
    } catch (error) {
      console.error('[referral-bonus] settlement failed:', error.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { settlePendingReferralBonuses, startReferralBonusScheduler };
