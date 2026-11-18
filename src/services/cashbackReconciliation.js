const { pool } = require('../config/postgres');

const RECONCILIATION_TOLERANCE = 0.01;

// MULTI_TENANCY B2: reconciliation always runs for ONE company (wallets,
// ledger and alerts carry company_id); the scheduler loops over companies.
function requireCompanyId(companyId) {
  const id = String(companyId || '').trim();
  if (!id) throw new Error('companyId is required for cashback reconciliation');
  return id;
}

async function reconcileCashbackBalances({ actor = 'scheduler', companyId } = {}) {
  const company = requireCompanyId(companyId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `with ledger as (
         select client_id,
                round(coalesce(sum(case
                  when kind = 'spend' then -amount
                  when kind = 'adjust' and coalesce(meta->>'direction', '') = 'debit' then -amount
                  else amount
                end), 0)::numeric, 2) as ledger_balance
           from cashback_transactions
          where company_id = $2
          group by client_id
       ), wallets as (
         select client_id, balance from cashback_wallets where company_id = $2
       )
       select coalesce(w.client_id, l.client_id) as client_id,
              round(coalesce(w.balance, 0)::numeric, 2) as wallet_balance,
              round(coalesce(l.ledger_balance, 0)::numeric, 2) as ledger_balance
         from wallets w
         full join ledger l on l.client_id = w.client_id
        where abs(round(coalesce(w.balance, 0)::numeric, 2) - round(coalesce(l.ledger_balance, 0)::numeric, 2)) > $1`,
      [RECONCILIATION_TOLERANCE, company],
    );

    for (const row of result.rows) {
      const walletBalance = Number(row.wallet_balance || 0);
      const ledgerBalance = Number(row.ledger_balance || 0);
      const difference = Number((walletBalance - ledgerBalance).toFixed(2));
      await client.query(
        `insert into cashback_reconciliation_alerts
          (client_id, wallet_balance, ledger_balance, difference, status, detected_at, resolved_at, metadata, company_id)
         values ($1, $2, $3, $4, 'OPEN', now(), null, $5::jsonb, $6)
         on conflict (client_id) where status = 'OPEN' do update set
           wallet_balance = excluded.wallet_balance,
           ledger_balance = excluded.ledger_balance,
           difference = excluded.difference,
           detected_at = now(),
           metadata = excluded.metadata`,
        [row.client_id, walletBalance, ledgerBalance, difference, JSON.stringify({ actor }), company],
      );
      await client.query(
        `insert into cashback_wallets (client_id, balance, updated_at, company_id)
         values ($1, $2, now(), $3)
         on conflict (client_id) do update
           set balance = excluded.balance, updated_at = now()`,
        [row.client_id, ledgerBalance, company],
      );
    }

    const resolved = await client.query(
      `update cashback_reconciliation_alerts a
          set status = 'RESOLVED', resolved_at = now()
        where a.status = 'OPEN'
          and a.company_id = $2
          and not exists (
            select 1 from cashback_wallets w
            left join cashback_transactions t on t.client_id = w.client_id
           where w.client_id = a.client_id
           group by w.client_id, w.balance
           having abs(round(w.balance::numeric, 2) - round(coalesce(sum(case
                    when t.kind = 'spend' then -t.amount
                    when t.kind = 'adjust' and coalesce(t.meta->>'direction', '') = 'debit' then -t.amount
                    else t.amount
                  end), 0)::numeric, 2)) > $1
          )
        returning id`,
      [RECONCILIATION_TOLERANCE, company],
    );

    await client.query(
      `insert into marketplace_audit_logs (action, entity_type, metadata)
       values ('CASHBACK_RECONCILIATION_RUN', 'cashback_wallet', $1::jsonb)`,
      [JSON.stringify({ actor, company_id: company, open_alerts: result.rows.length, resolved_alerts: resolved.rowCount })],
    );
    await client.query('COMMIT');
    return { discrepancies: result.rows.length, resolved: resolved.rowCount };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* no-op */ }
    throw error;
  } finally {
    client.release();
  }
}

async function listReconciliationAlerts({ status = 'OPEN', limit = 100, companyId } = {}) {
  const company = requireCompanyId(companyId);
  const normalizedStatus = ['OPEN', 'RESOLVED'].includes(status) ? status : 'OPEN';
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const result = await pool.query(
    `select a.id, a.client_id, c.name as client_name, c.phone,
            a.wallet_balance, a.ledger_balance, a.difference,
            a.status, a.detected_at, a.resolved_at, a.metadata
       from cashback_reconciliation_alerts a
       left join clients c on c.id = a.client_id
      where a.status = $1
        and a.company_id = $3
      order by a.detected_at desc
      limit $2`,
    [normalizedStatus, safeLimit, company],
  );
  return result.rows;
}

// Every company, one transaction each: a failure in one company neither
// rolls back nor blocks the others.
async function reconcileAllCompanies({ actor = 'scheduler' } = {}) {
  const companies = await pool.query('select id from companies order by created_at asc, id asc');
  const results = [];
  for (const { id } of companies.rows || []) {
    try {
      results.push({ companyId: String(id), ...(await reconcileCashbackBalances({ actor, companyId: id })) });
    } catch (error) {
      console.error('[cashback-reconciliation] company failed:', { companyId: String(id), message: error.message });
      results.push({ companyId: String(id), error: error.message });
    }
  }
  return results;
}

function startCashbackReconciliationScheduler() {
  const intervalMs = Math.max(Number(process.env.CASHBACK_RECONCILIATION_INTERVAL_MS || 3600000), 60000);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileAllCompanies({ actor: 'scheduler' });
    } catch (error) {
      // The migration may not be applied on a legacy deployment yet.
      console.error('[cashback-reconciliation] failed:', error.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = {
  reconcileAllCompanies,
  reconcileCashbackBalances,
  listReconciliationAlerts,
  startCashbackReconciliationScheduler,
};
