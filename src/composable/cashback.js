const { db, pool } = require('../config/postgres');
const { resolveLoyaltyCashbackPercent } = require('../utils/loyalty');

const DEFAULT_CASHBACK_CONFIG = {
  default_percent: 1,
  promotion_percent: null,
  promotion_start_date: null,
  promotion_end_date: null,
  timezone: 'Asia/Tashkent',
};

const roundMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
};

const parsePercent = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 100);
};

async function getCashbackPercentForEntry(entry) {
  const fallback = parsePercent(process.env.CASHBACK_PERCENT);
  if (!entry?.client_id) return fallback;

  try {
    const configuredCashback = await pool.query(
      `select value from platform_settings where key = 'cashback'`,
    );
    if (configuredCashback.rows[0]?.value && typeof configuredCashback.rows[0].value === 'object') {
      const config = { ...DEFAULT_CASHBACK_CONFIG, ...configuredCashback.rows[0].value };
      const timezone = String(config.timezone || 'Asia/Tashkent');
      const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
      const promotionIsActive = config.promotion_percent !== null
        && config.promotion_start_date
        && config.promotion_end_date
        && localDate >= String(config.promotion_start_date)
        && localDate <= String(config.promotion_end_date);
      return parsePercent(promotionIsActive ? config.promotion_percent : config.default_percent);
    }

    const marketplaceClient = await pool.query(
      `select mc.status_points
         from marketplace_clients mc
         join clients c on c.phone = mc.phone
        where c.id = $1
        limit 1`,
      [entry.client_id],
    );
    if (!marketplaceClient.rows[0]) return fallback;

    const settings = await pool.query(
      `select value from platform_settings where key = 'loyalty_levels'`,
    );
    return resolveLoyaltyCashbackPercent(
      marketplaceClient.rows[0].status_points,
      settings.rows[0]?.value,
      0,
    );
  } catch (error) {
    if (error?.code === '42P01' || String(error?.message || '').includes('marketplace_')) {
      return fallback;
    }
    throw error;
  }
}

async function getPaidMoneyForQueueEntry(queueEntryId) {
  const result = await pool.query(
    `select coalesce(sum(amount) filter (where method in ('payme', 'click', 'cash', 'card')), 0)::numeric as paid_money,
            count(*)::int as payment_count
       from payments
      where queue_entry_id = $1`,
    [queueEntryId],
  );
  return {
    amount: roundMoney(result.rows[0]?.paid_money),
    hasRecords: Number(result.rows[0]?.payment_count || 0) > 0,
  };
}

const getServiceIdsFromEntry = (entry) => {
  if (Array.isArray(entry?.service_ids) && entry.service_ids.length) {
    return entry.service_ids.filter(Boolean);
  }
  if (entry?.service_id) return [entry.service_id];
  return [];
};

async function getServicesTotal(serviceIds) {
  const ids = Array.isArray(serviceIds) ? serviceIds.filter(Boolean) : [];
  if (!ids.length) return 0;

  const { data, error } = await db
    .from('services')
    .select('id,base_price')
    .in('id', ids);

  if (error) throw error;

  const total = (data || []).reduce((sum, row) => {
    const price = Number(row?.base_price);
    return sum + (Number.isFinite(price) ? price : 0);
  }, 0);

  return roundMoney(total);
}

const getOverrideTotal = (entry) => {
  const amount = Number(entry?.price_override);
  return Number.isFinite(amount) && amount > 0 ? roundMoney(amount) : null;
};

async function getPromoForOrder(orderId) {
  if (!orderId) return null;

  const { data: usage, error: usageError } = await db
    .from('promo_code_usage')
    .select('promo_code_id, used_at')
    .eq('order_id', String(orderId))
    .order('used_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (usageError) throw usageError;
  if (!usage?.promo_code_id) return null;

  const { data: promo, error: promoError } = await db
    .from('promo_codes')
    .select('id, code, discount_type, discount_value')
    .eq('id', usage.promo_code_id)
    .maybeSingle();

  if (promoError) throw promoError;
  return promo || null;
}

function applyPromoDiscount(total, promo) {
  const base = Number(total);
  if (!Number.isFinite(base) || base <= 0 || !promo) return roundMoney(base);

  const value = Number(promo.discount_value);
  if (!Number.isFinite(value) || value <= 0) return roundMoney(base);

  let discounted = base;
  if (promo.discount_type === 'percentage') {
    discounted = base - (base * value) / 100;
  } else if (promo.discount_type === 'fixed') {
    discounted = base - value;
  }

  return roundMoney(Math.max(0, discounted));
}

async function spendCashback({ clientId, queueEntryId, amount, meta }) {
  if (!clientId || !queueEntryId) {
    return { spent: false, amount: 0, balance: null, reason: 'missing_params', transaction: null };
  }

  const amt = roundMoney(amount);
  if (!amt || amt <= 0) {
    return { spent: false, amount: 0, balance: await getWalletBalance(clientId), transaction: null };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `insert into cashback_wallets (client_id, balance) values ($1, 0)
       on conflict (client_id) do nothing`, [clientId]
    );
    const wallet = await client.query(
      `select balance from cashback_wallets where client_id = $1 for update`, [clientId]
    );
    const balance = roundMoney(wallet.rows[0]?.balance);
    if (balance < amt) {
      await client.query('ROLLBACK');
      return { spent: false, amount: 0, balance, reason: 'insufficient_balance', transaction: null };
    }
    const transaction = await client.query(
      `insert into cashback_transactions (client_id, queue_entry_id, kind, amount, meta, request_id)
       values ($1, $2, 'spend', $3, $4::jsonb, $5)
       on conflict (request_id) do nothing
       returning id, client_id, queue_entry_id, kind, amount, created_at`,
      [clientId, queueEntryId, amt, JSON.stringify({
        source: 'cashback_spend',
        description: 'Использование бонусов при оплате заказа',
        ...(meta || {}),
      }), `cashback_spend:${queueEntryId}`]
    );
    if (!transaction.rows[0]) {
      await client.query('ROLLBACK');
      return { spent: false, amount: 0, balance, reason: 'already_spent', transaction: null };
    }
    const updated = await client.query(
      `update cashback_wallets set balance = round((balance - $2)::numeric, 2), updated_at = now()
        where client_id = $1 and balance >= $2 returning balance`, [clientId, amt]
    );
    if (!updated.rows[0]) {
      await client.query('ROLLBACK');
      return { spent: false, amount: 0, balance, reason: 'insufficient_balance', transaction: null };
    }
    await client.query('COMMIT');
    return { spent: true, amount: amt, balance: roundMoney(updated.rows[0].balance), transaction: transaction.rows[0] };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (error?.code === '42P01' || String(error?.message || '').includes('cashback_')) {
      return { spent: false, amount: 0, balance: null, reason: 'cashback_schema_unavailable', transaction: null };
    }
    throw error;
  } finally {
    client.release();
  }
}

async function refundCashbackSpend({ clientId, queueEntryId, amount, transactionId }) {
  if (!clientId) {
    return { refunded: false, balance: null };
  }

  const amt = roundMoney(amount);
  if (!amt || amt <= 0) {
    return { refunded: false, balance: await getWalletBalance(clientId) };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const original = transactionId
      ? await client.query(`select id, amount from cashback_transactions where id = $1 and client_id = $2 for update`, [transactionId, clientId])
      : await client.query(`select id, amount from cashback_transactions where queue_entry_id = $1 and client_id = $2 and kind = 'spend' for update`, [queueEntryId, clientId]);
    if (!original.rows[0]) {
      await client.query('ROLLBACK');
      return { refunded: false, balance: await getWalletBalance(clientId), reason: 'spend_not_found' };
    }
    const refundAmount = roundMoney(Math.min(amt, Number(original.rows[0].amount) || 0));
    if (refundAmount <= 0) {
      await client.query('ROLLBACK');
      return { refunded: false, balance: await getWalletBalance(clientId), reason: 'invalid_refund_amount' };
    }
    const reversal = await client.query(
      `insert into cashback_transactions (client_id, queue_entry_id, kind, amount, reversal_of, meta, request_id)
       values ($1, $2, 'adjust', $3, $4, $5::jsonb, $6)
       on conflict (reversal_of, kind) where reversal_of is not null do nothing
       returning id`,
      [clientId, queueEntryId || null, refundAmount, original.rows[0].id, JSON.stringify({
        type: 'spend_reversal',
        source: 'cashback_refund',
        description: 'Возврат списанных бонусов',
      }), `cashback_refund:${original.rows[0].id}`]
    );
    if (!reversal.rows[0]) {
      await client.query('ROLLBACK');
      return { refunded: false, balance: await getWalletBalance(clientId), reason: 'already_refunded' };
    }
    await client.query(
      `insert into cashback_wallets (client_id, balance) values ($1, $2)
       on conflict (client_id) do update set balance = round((cashback_wallets.balance + excluded.balance)::numeric, 2), updated_at = now()`,
      [clientId, refundAmount]
    );
    const wallet = await client.query(`select balance from cashback_wallets where client_id = $1`, [clientId]);
    await client.query('COMMIT');
    return { refunded: true, balance: roundMoney(wallet.rows[0]?.balance), transaction_id: reversal.rows[0].id };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

async function getCashbackSpendForOrder(orderId) {
  if (!orderId) return 0;

  const { data, error } = await db
    .from('cashback_transactions')
    .select('amount')
    .eq('queue_entry_id', String(orderId))
    .eq('kind', 'spend')
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const amount = Number(data?.amount);
  return Number.isFinite(amount) ? roundMoney(amount) : 0;
}

async function getWalletBalance(clientId) {
  if (!clientId) return 0;

  // The ledger is shared by cashback and referral rewards; the wallet row is
  // a materialized snapshot and may be absent or stale on older deployments.
  const result = await pool.query(
    `select coalesce(sum(
       case
         when kind = 'spend' then -amount
         when kind = 'adjust' and coalesce(meta->>'type', '') = 'spend_reversal' then amount
         when kind = 'adjust' and coalesce(meta->>'direction', '') = 'debit' then -amount
         else amount
       end
     ), 0)::numeric as balance
       from cashback_transactions
      where client_id = $1`,
    [clientId],
  );

  return roundMoney(result.rows[0]?.balance);
}

async function ensureWallet(clientId) {
  if (!clientId) return null;

  const { data, error } = await db
    .from('cashback_wallets')
    .upsert({ client_id: clientId, balance: 0, updated_at: new Date().toISOString() }, {
      onConflict: 'client_id',
      ignoreDuplicates: true,
    })
    .select('client_id,balance')
    .maybeSingle();

  if (error) {
    const msg = String(error.message || '');
    if (msg.includes("Could not find the 'cashback_wallets'") || msg.includes('cashback_wallets')) {
      return null;
    }
    throw error;
  }

  return data || null;
}

async function incrementWalletBalance(clientId, delta) {
  if (!clientId) return 0;
  const d = roundMoney(delta);
  if (!d) return getWalletBalance(clientId);

  try {
    const { rows } = await db.query(
      `
        insert into cashback_wallets (client_id, balance, updated_at)
        values ($1, $2::numeric, now())
        on conflict (client_id)
        do update set
          balance = round((cashback_wallets.balance + excluded.balance)::numeric, 2),
          updated_at = now()
        returning balance
      `,
      [clientId, d]
    );

    const balance = Number(rows?.[0]?.balance);
    return Number.isFinite(balance) ? roundMoney(balance) : getWalletBalance(clientId);
  } catch (error) {
    const msg = String(error?.message || '');
    if (msg.includes("Could not find the 'cashback_wallets'") || msg.includes('cashback_wallets')) {
      return 0;
    }
    throw error;
  }
}

async function decrementWalletBalance(clientId, amount) {
  if (!clientId) return { ok: false, balance: null };
  const amt = roundMoney(amount);
  if (!amt || amt <= 0) return { ok: true, balance: await getWalletBalance(clientId) };

  await ensureWallet(clientId);

  try {
    const { rows } = await db.query(
      `
        update cashback_wallets
        set
          balance = round((balance - $2::numeric)::numeric, 2),
          updated_at = now()
        where client_id = $1
          and balance >= $2::numeric
        returning balance
      `,
      [clientId, amt]
    );

    if (rows?.[0]) {
      const balance = Number(rows[0].balance);
      return { ok: true, balance: Number.isFinite(balance) ? roundMoney(balance) : 0 };
    }
  } catch (error) {
    const msg = String(error?.message || '');
    if (msg.includes("Could not find the 'cashback_wallets'") || msg.includes('cashback_wallets')) {
      return { ok: false, balance: 0 };
    }
    throw error;
  }

  return { ok: false, balance: await getWalletBalance(clientId) };
}

async function syncCashbackWalletsFromTransactions({ clientId = null, dryRun = false } = {}) {
  const params = [];
  const clientFilter = clientId ? 'where client_id = $1' : '';
  const clientJoinFilter = clientId ? 'where c.id = $1' : '';
  if (clientId) params.push(clientId);

  const driftSql = `
    with transaction_balances as (
      select
        client_id,
        round(
          coalesce(sum(
            case
              when kind = 'earn' then amount
              when kind = 'spend' then -amount
              else amount
            end
          ), 0)::numeric,
          2
        ) as balance
      from cashback_transactions
      ${clientFilter}
      group by client_id
    )
    select
      c.id as client_id,
      c.phone,
      coalesce(w.balance, 0)::numeric as wallet_balance,
      coalesce(tb.balance, 0)::numeric as transaction_balance,
      round((coalesce(tb.balance, 0) - coalesce(w.balance, 0))::numeric, 2) as delta
    from clients c
    left join cashback_wallets w on w.client_id = c.id
    left join transaction_balances tb on tb.client_id = c.id
    ${clientJoinFilter}
    where coalesce(w.balance, 0) <> coalesce(tb.balance, 0)
    order by abs(coalesce(tb.balance, 0) - coalesce(w.balance, 0)) desc
  `;

  if (dryRun) {
    const { rows } = await db.query(driftSql, params);
    return { dry_run: true, updated: 0, rows };
  }

  const syncSql = `
    with transaction_balances as (
      select
        client_id,
        round(
          coalesce(sum(
            case
              when kind = 'earn' then amount
              when kind = 'spend' then -amount
              else amount
            end
          ), 0)::numeric,
          2
        ) as balance
      from cashback_transactions
      ${clientFilter}
      group by client_id
    ),
    target_clients as (
      select c.id as client_id, coalesce(tb.balance, 0)::numeric as balance
      from clients c
      left join transaction_balances tb on tb.client_id = c.id
      ${clientJoinFilter}
    )
    insert into cashback_wallets (client_id, balance, updated_at)
    select client_id, balance, now()
    from target_clients
    on conflict (client_id)
    do update set
      balance = excluded.balance,
      updated_at = now()
    returning client_id, balance
  `;

  const { rows } = await db.query(syncSql, params);
  return { dry_run: false, updated: rows.length, rows };
}

async function insertCashbackTransaction({ clientId, queueEntryId, kind, amount, meta }) {
  if (!clientId) return { inserted: false, transaction: null };
  if (!kind) return { inserted: false, transaction: null };

  const amt = roundMoney(amount);
  if (!amt || amt <= 0) return { inserted: false, transaction: null };

  const payload = {
    client_id: clientId,
    queue_entry_id: queueEntryId || null,
    kind,
    amount: amt,
    meta: meta || null,
  };

  const { data, error } = await db
    .from('cashback_transactions')
    .insert(payload)
    .select('id, client_id, queue_entry_id, kind, amount, created_at');

  if (error) {
    if (error.code === '23505') {
      return { inserted: false, transaction: null };
    }
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return { inserted: Boolean(row?.id), transaction: row || null };
}

async function computeCashbackTotalsForQueueEntry(entry) {
  if (!entry?.id) {
    return { total: 0, discountedTotal: 0, promo: null };
  }

  const serviceIds = getServiceIdsFromEntry(entry);
  const total = getOverrideTotal(entry) ?? await getServicesTotal(serviceIds);
  const promo = await getPromoForOrder(entry.id);
  const discountedTotal = applyPromoDiscount(total, promo);

  return { total, discountedTotal, promo };
}

async function spendCashbackForQueueEntry(entry, amountInput) {
  if (!entry?.id || !entry?.client_id) {
    return { spent: false, amount: 0, balance: null, reason: 'missing_entry' };
  }

  const amount = roundMoney(amountInput);
  if (!amount || amount <= 0) {
    return { spent: false, amount: 0, balance: await getWalletBalance(entry.client_id) };
  }

  const usedCertificate =
    entry.payment_method === 'certificate' || Boolean(entry.certificate_id);
  if (usedCertificate) {
    return { spent: false, amount: 0, balance: await getWalletBalance(entry.client_id), reason: 'certificate_payment' };
  }

  const { total, discountedTotal, promo } = await computeCashbackTotalsForQueueEntry(entry);
  if (discountedTotal <= 0) {
    return { spent: false, amount: 0, balance: await getWalletBalance(entry.client_id), reason: 'zero_total' };
  }

  let maxRedeemShare = 1;
  const { data: policy } = await db.from('platform_settings').select('value').eq('key', 'cashback_policy').maybeSingle();
  const configuredShare = Number(policy?.value?.max_redeem_share ?? policy?.value?.maxRedeemShare);
  if (Number.isFinite(configuredShare)) maxRedeemShare = Math.min(1, Math.max(0, configuredShare));
  const maxSpend = roundMoney(discountedTotal * maxRedeemShare);
  if (amount > maxSpend) {
    return {
      spent: false,
      amount: 0,
      balance: await getWalletBalance(entry.client_id),
      reason: 'exceeds_order_total',
      max: maxSpend,
      max_share: maxRedeemShare,
    };
  }

  const balance = await getWalletBalance(entry.client_id);
  if (balance < amount) {
    return { spent: false, amount: 0, balance, reason: 'insufficient_balance' };
  }

  const spendRes = await spendCashback({
    clientId: entry.client_id,
    queueEntryId: entry.id,
    amount,
    meta: {
      total,
      discounted_total: discountedTotal,
      promo_code: promo?.code || null,
    },
  });

  if (!spendRes?.spent) {
    return {
      spent: false,
      amount: 0,
      balance: spendRes?.balance ?? balance,
      reason: spendRes?.reason || 'spend_failed',
    };
  }

  return { spent: true, amount: spendRes.amount, balance: spendRes.balance };
}

async function awardCashbackForCompletedQueueEntry(entry) {
  if (!entry?.id) return { awarded: false, balance: null, reason: 'missing_queue_entry_id' };
  if (!entry?.client_id) return { awarded: false, balance: null, reason: 'missing_client_id' };
  if (String(entry.status || '').toLowerCase() !== 'completed') {
    return { awarded: false, balance: null, reason: 'order_not_completed' };
  }

  const percent = await getCashbackPercentForEntry(entry);
  if (!percent) return { awarded: false, balance: null, reason: 'cashback_percent_zero' };

  const usedCertificate =
    entry.payment_method === 'certificate' || Boolean(entry.certificate_id);

  if (usedCertificate) return { awarded: false, balance: null, reason: 'certificate_payment' };

  try {
    const { total, discountedTotal, promo } = await computeCashbackTotalsForQueueEntry(entry);
    if (total <= 0) return { awarded: false, balance: null, reason: 'zero_order_total' };

    const spent = await getCashbackSpendForOrder(entry.id);
    const recordedPayments = await getPaidMoneyForQueueEntry(entry.id);
    const calculatedNetPaid = roundMoney(Math.max(0, discountedTotal - spent));
    // When payment rows exist, trust only cash/card rows. This prevents a
    // certificate (including mixed payment) portion from earning cashback.
    // The fallback preserves legacy kiosk installations that completed old
    // entries without writing payment rows.
    const legacyMoneyMethod = ['payme', 'click', 'cash', 'card'].includes(
      String(entry.payment_method || '').toLowerCase(),
    );
    const netPaid = recordedPayments.hasRecords
      ? roundMoney(Math.min(calculatedNetPaid, recordedPayments.amount))
      : legacyMoneyMethod
        ? calculatedNetPaid
        : 0;
    if (netPaid <= 0) {
      return {
        awarded: false,
        balance: await getWalletBalance(entry.client_id),
        earned: 0,
        reason: recordedPayments.hasRecords ? 'zero_eligible_paid_amount' : 'missing_payment_records',
      };
    }

    const cashbackEarned = roundMoney((netPaid * percent) / 100);
    if (!cashbackEarned) {
      return {
        awarded: false,
        balance: await getWalletBalance(entry.client_id),
        earned: 0,
        reason: 'cashback_amount_rounds_to_zero',
      };
    }

    const ledgerMeta = {
      source: 'cashback_order',
      description: 'Кэшбэк за заказ',
      order_total: total,
      paid_amount: netPaid,
      cashback_percent: percent,
      percent,
      total,
      discounted_total: discountedTotal,
      cashback_spent: spent,
      net_paid: netPaid,
      paid_money: recordedPayments.amount,
      promo_code: promo?.code || null,
    };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const transaction = await client.query(
        `insert into cashback_transactions (client_id, queue_entry_id, kind, amount, meta, request_id)
         values ($1, $2, 'earn', $3, $4::jsonb, $5)
         on conflict (request_id) do nothing returning id`,
        [entry.client_id, entry.id, cashbackEarned, JSON.stringify(ledgerMeta), `cashback_order:${entry.id}`]
      );
      if (!transaction.rows[0]) {
        await client.query('ROLLBACK');
        return { awarded: false, balance: null, reason: 'already_awarded' };
      }
      // Settlement is an additive accounting record. Keep cashback awarding
      // compatible with installations that have not applied the new table yet.
      await client.query('SAVEPOINT cashback_settlement');
      try {
        await client.query(
          `insert into cashback_settlements (queue_entry_id, branch_id, client_id, cashback_amount, metadata)
           values ($1, $2, $3, $4, $5::jsonb)
           on conflict (queue_entry_id) do update set cashback_amount = excluded.cashback_amount, updated_at = now()`,
          [entry.id, entry.branch_id || null, entry.client_id, cashbackEarned, JSON.stringify({ percent, net_paid: netPaid })]
        );
        await client.query('RELEASE SAVEPOINT cashback_settlement');
      } catch (settlementError) {
        await client.query('ROLLBACK TO SAVEPOINT cashback_settlement');
        console.warn('Cashback settlement table is unavailable:', settlementError.message);
      }
      const wallet = await client.query(
        `insert into cashback_wallets (client_id, balance) values ($1, $2)
         on conflict (client_id) do update set balance = round((cashback_wallets.balance + excluded.balance)::numeric, 2), updated_at = now()
         returning balance`, [entry.client_id, cashbackEarned]
      );
      // Marketplace clients should see a transaction notification only after
      // the cashback ledger and wallet update succeed. Keep this optional for
      // legacy kiosk deployments that have not applied the marketplace schema.
      await client.query('SAVEPOINT cashback_notification');
      try {
        await client.query(
          `insert into marketplace_notifications (marketplace_client_id, type, payload)
           select mc.id, 'CASHBACK_EARNED', $2::jsonb
             from marketplace_clients mc
             join clients c on c.phone = mc.phone
            where c.id = $1
              and not exists (
                select 1 from marketplace_notifications n
                 where n.marketplace_client_id = mc.id
                   and n.type = 'CASHBACK_EARNED'
                   and n.payload ->> 'queue_entry_id' = $3::text
              )`,
          [entry.client_id, JSON.stringify({
            queue_entry_id: entry.id,
            amount: cashbackEarned,
            balance: roundMoney(wallet.rows[0]?.balance),
          }), entry.id],
        );
        await client.query('RELEASE SAVEPOINT cashback_notification');
      } catch (notificationError) {
        await client.query('ROLLBACK TO SAVEPOINT cashback_notification');
        console.warn('Cashback notification table is unavailable:', notificationError.message);
      }
      await client.query('COMMIT');
      return { awarded: true, balance: roundMoney(wallet.rows[0]?.balance), earned: cashbackEarned };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw error;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Cashback award failed:', e?.message || e);
    throw e;
  }
}

module.exports = {
  roundMoney,
  parsePercent,
  applyPromoDiscount,
  getWalletBalance,
  computeCashbackTotalsForQueueEntry,
  spendCashback,
  refundCashbackSpend,
  syncCashbackWalletsFromTransactions,
  spendCashbackForQueueEntry,
  awardCashbackForCompletedQueueEntry,
};
