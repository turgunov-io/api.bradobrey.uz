const { pool } = require('../config/postgres');

async function creditReferralToCashbackWallet(client, { referralTransactionId, referrerClientId, amount, bookingId }) {
  const referrer = await client.query(
    `select phone, coalesce(nullif(display_name, ''), 'Client') as display_name
       from marketplace_clients
      where id = $1
      for update`,
    [referrerClientId],
  );
  const phone = referrer.rows[0]?.phone;
  if (!phone) throw new Error('Referrer phone is required for cashback wallet');

  const legacyClient = await client.query(
    `insert into clients (name, phone)
     values ($1, $2)
     on conflict (phone) do update set name = coalesce(nullif(clients.name, ''), excluded.name)
     returning id`,
    [referrer.rows[0].display_name, phone],
  );
  const legacyClientId = legacyClient.rows[0]?.id;
  if (!legacyClientId) throw new Error('Unable to resolve referrer cashback wallet');

  const requestId = `referral_bonus:${referralTransactionId}`;
  const walletTransaction = await client.query(
    `insert into cashback_transactions
      (client_id, kind, amount, meta, request_id)
     values ($1, 'adjust', $2, $3::jsonb, $4)
     on conflict (request_id) do nothing
     returning id`,
    [legacyClientId, amount, JSON.stringify({ source: 'referral', booking_id: bookingId, referral_transaction_id: referralTransactionId }), requestId],
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
    `select rt.id as referral_transaction_id, rt.booking_id, rt.amount,
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
      `select r.id as referral_id, r.referrer_client_id, b.id as booking_id,
              round((
                coalesce(sum(pay.amount) filter (where pay.method in ('cash', 'card')), 0)
                + coalesce(sum(
                    case
                      when pay.queue_entry_id is null and q.payment_method in ('payme', 'click', 'cash', 'card') then
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
         join marketplace_bookings b on b.marketplace_client_id = r.referred_client_id
         join marketplace_booking_persons bp on bp.booking_id = b.id
         join queue_entries q on q.id = bp.queue_entry_id and q.status = 'completed'
         left join payments pay on pay.queue_entry_id = q.id
        where r.expires_at > now()
          and b.status in ('ACTIVE', 'COMPLETED')
          ${referrerFilter}
          and not exists (
            select 1 from referral_transactions rt
             where rt.referral_id = r.id and rt.booking_id = b.id
          )
          and not exists (
            select 1
              from marketplace_booking_persons pending_bp
              join queue_entries pending_q on pending_q.id = pending_bp.queue_entry_id
             where pending_bp.booking_id = b.id
               and pending_q.status <> 'completed'
          )
        group by r.id, r.referrer_client_id, b.id
        order by b.updated_at asc
        limit $1`,
      params,
    );

    for (const row of candidates.rows) {
      await client.query(
        `update marketplace_bookings
            set status = 'COMPLETED', updated_at = now()
          where id = $1 and status = 'ACTIVE'`,
        [row.booking_id],
      );
      const paidMoney = Number(row.paid_money || 0);
      // Referral rewards are whole cashback points: 1 point equals 1 sum.
      const bonus = Math.floor(paidMoney * Number(row.bonus_percent || 1) / 100);
      if (paidMoney <= 0 || bonus <= 0) continue;

      const inserted = await client.query(
        `insert into referral_transactions
          (referral_id, booking_id, amount, paid_with_money)
         values ($1, $2, $3, $4)
         on conflict (referral_id, booking_id) do nothing
         returning id`,
        [row.referral_id, row.booking_id, bonus, paidMoney],
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
      });
      settled += 1;
    }
    await backfillReferralWallets(client, { limit: 100 });
    await client.query('COMMIT');
    return { settled };
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
