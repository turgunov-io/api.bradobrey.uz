const { db } = require('../config/postgres');

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

  const balance = await getWalletBalance(clientId);
  if (balance < amt) {
    return { spent: false, amount: 0, balance, reason: 'insufficient_balance', transaction: null };
  }

  const { inserted, transaction } = await insertCashbackTransaction({
    clientId,
    queueEntryId,
    kind: 'spend',
    amount: amt,
    meta: meta || null,
  });

  if (!inserted) {
    return { spent: false, amount: 0, balance: await getWalletBalance(clientId), reason: 'already_spent', transaction: null };
  }

  const { ok, balance: nextBalance } = await decrementWalletBalance(clientId, amt);
  if (!ok) {
    if (transaction?.id) {
      await db
        .from('cashback_transactions')
        .delete()
        .eq('id', transaction.id)
        .catch(() => { });
    }
    return { spent: false, amount: 0, balance: nextBalance ?? balance, reason: 'insufficient_balance', transaction: null };
  }

  return { spent: true, amount: amt, balance: nextBalance, transaction };
}

async function refundCashbackSpend({ clientId, queueEntryId, amount, transactionId }) {
  if (!clientId) {
    return { refunded: false, balance: null };
  }

  const amt = roundMoney(amount);
  if (!amt || amt <= 0) {
    return { refunded: false, balance: await getWalletBalance(clientId) };
  }

  try {
    if (transactionId) {
      await db.from('cashback_transactions').delete().eq('id', transactionId);
    } else if (queueEntryId) {
      await db
        .from('cashback_transactions')
        .delete()
        .eq('queue_entry_id', String(queueEntryId))
        .eq('kind', 'spend');
    }
  } catch (_) {
    // best-effort
  }

  const balance = await incrementWalletBalance(clientId, amt);
  return { refunded: true, balance };
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
    const msg = String(error.message || '');
    if (msg.includes("Could not find the 'cashback_transactions'") || msg.includes('cashback_transactions')) {
      return 0;
    }
    throw error;
  }

  const amount = Number(data?.amount);
  return Number.isFinite(amount) ? roundMoney(amount) : 0;
}

async function getWalletBalance(clientId) {
  if (!clientId) return 0;

  const { data, error } = await db
    .from('cashback_wallets')
    .select('client_id,balance')
    .eq('client_id', clientId)
    .maybeSingle();

  if (error) {
    const msg = String(error.message || '');
    if (msg.includes("Could not find the 'cashback_wallets'") || msg.includes('cashback_wallets')) {
      return 0;
    }
    throw error;
  }

  const balance = Number(data?.balance);
  return Number.isFinite(balance) ? roundMoney(balance) : 0;
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
    const msg = String(error.message || '');
    if (msg.includes("Could not find the 'cashback_transactions'") || msg.includes('cashback_transactions')) {
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

  if (amount > discountedTotal) {
    return {
      spent: false,
      amount: 0,
      balance: await getWalletBalance(entry.client_id),
      reason: 'exceeds_order_total',
      max: discountedTotal,
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
  if (!entry?.id || !entry?.client_id) return { awarded: false, balance: null };

  const percent = parsePercent(process.env.CASHBACK_PERCENT);
  if (!percent) return { awarded: false, balance: null };

  const usedCertificate =
    entry.payment_method === 'certificate' || Boolean(entry.certificate_id);

  if (usedCertificate) return { awarded: false, balance: null };

  try {
    const { total, discountedTotal, promo } = await computeCashbackTotalsForQueueEntry(entry);
    if (total <= 0) return { awarded: false, balance: null };

    const spent = await getCashbackSpendForOrder(entry.id);
    const netPaid = roundMoney(Math.max(0, discountedTotal - spent));
    if (netPaid <= 0) return { awarded: false, balance: await getWalletBalance(entry.client_id), earned: 0 };

    const cashbackEarned = roundMoney((netPaid * percent) / 100);
    if (!cashbackEarned) return { awarded: false, balance: await getWalletBalance(entry.client_id), earned: 0 };

    const { inserted } = await insertCashbackTransaction({
      clientId: entry.client_id,
      queueEntryId: entry.id,
      kind: 'earn',
      amount: cashbackEarned,
      meta: {
        percent,
        total,
        discounted_total: discountedTotal,
        cashback_spent: spent,
        net_paid: netPaid,
        promo_code: promo?.code || null,
      },
    });

    if (!inserted) return { awarded: false, balance: null };

    const balance = await incrementWalletBalance(entry.client_id, cashbackEarned);
    return { awarded: true, balance, earned: cashbackEarned };
  } catch (e) {
    console.error('Cashback award failed:', e?.message || e);
    return { awarded: false, balance: null };
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
