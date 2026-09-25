const { pool } = require('../config/postgres');

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
              round(sum(pay.amount)::numeric, 2) as paid_money,
              coalesce((select (value ->> 'bonus_percent')::numeric
                          from platform_settings where key = 'referral'), 1) as bonus_percent
         from referrals r
         join marketplace_bookings b on b.marketplace_client_id = r.referred_client_id
         join marketplace_booking_persons bp on bp.booking_id = b.id
         join queue_entries q on q.id = bp.queue_entry_id and q.status = 'completed'
         join payments pay on pay.queue_entry_id = q.id and pay.method in ('cash', 'card')
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
      const bonus = Number((paidMoney * Number(row.bonus_percent || 1) / 100).toFixed(2));
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
        `update marketplace_clients
            set referral_bonus_balance = referral_bonus_balance + $2
          where id = $1`,
        [row.referrer_client_id, bonus],
      );
      await client.query(
        `insert into marketplace_notifications (marketplace_client_id, type, payload)
         values ($1, 'REFERRAL_BONUS', $2::jsonb)`,
        [row.referrer_client_id, JSON.stringify({ amount: bonus, booking_id: row.booking_id })],
      );
      settled += 1;
    }
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
