const { supabase } = require('../config/supabase');

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

  const { data, error } = await supabase
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

async function getPromoForOrder(orderId) {
  if (!orderId) return null;

  const { data: usage, error: usageError } = await supabase
    .from('promo_code_usage')
    .select('promo_code_id, used_at')
    .eq('order_id', String(orderId))
    .order('used_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (usageError) throw usageError;
  if (!usage?.promo_code_id) return null;

  const { data: promo, error: promoError } = await supabase
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
      await supabase
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
      await supabase.from('cashback_transactions').delete().eq('id', transactionId);
    } else if (queueEntryId) {
      await supabase
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

  const { data, error } = await supabase
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

  const { data, error } = await supabase
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

  const { data, error } = await supabase
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

  await ensureWallet(clientId);

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: wallet, error: walletError } = await supabase
      .from('cashback_wallets')
      .select('client_id,balance')
      .eq('client_id', clientId)
      .maybeSingle();

    if (walletError) {
      const msg = String(walletError.message || '');
      if (msg.includes("Could not find the 'cashback_wallets'") || msg.includes('cashback_wallets')) {
        return 0;
      }
      throw walletError;
    }

    const current = Number(wallet?.balance);
    const currentNum = Number.isFinite(current) ? current : 0;
    const next = roundMoney(currentNum + d);

    const { data: updated, error: updateError } = await supabase
      .from('cashback_wallets')
      .update({ balance: next, updated_at: new Date().toISOString() })
      .eq('client_id', clientId)
      .select('balance')
      .maybeSingle();

    if (updateError) {
      const msg = String(updateError.message || '');
      if (msg.includes("Could not find the 'cashback_wallets'") || msg.includes('cashback_wallets')) {
        return 0;
      }
      throw updateError;
    }

    if (updated) {
      const updatedNum = Number(updated.balance);
      return Number.isFinite(updatedNum) ? roundMoney(updatedNum) : next;
    }
  }

  return getWalletBalance(clientId);
}

async function decrementWalletBalance(clientId, amount) {
  if (!clientId) return { ok: false, balance: null };
  const amt = roundMoney(amount);
  if (!amt || amt <= 0) return { ok: true, balance: await getWalletBalance(clientId) };

  await ensureWallet(clientId);

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: wallet, error: walletError } = await supabase
      .from('cashback_wallets')
      .select('client_id,balance')
      .eq('client_id', clientId)
      .maybeSingle();

    if (walletError) {
      const msg = String(walletError.message || '');
      if (msg.includes("Could not find the 'cashback_wallets'") || msg.includes('cashback_wallets')) {
        return { ok: false, balance: 0 };
      }
      throw walletError;
    }

    const current = Number(wallet?.balance);
    const currentNum = Number.isFinite(current) ? current : 0;
    const currentRounded = roundMoney(currentNum);

    if (currentRounded < amt) {
      return { ok: false, balance: currentRounded };
    }

    const next = roundMoney(currentRounded - amt);

    const { data: updated, error: updateError } = await supabase
      .from('cashback_wallets')
      .update({ balance: next, updated_at: new Date().toISOString() })
      .eq('client_id', clientId)
      .select('balance')
      .maybeSingle();

    if (updateError) {
      const msg = String(updateError.message || '');
      if (msg.includes("Could not find the 'cashback_wallets'") || msg.includes('cashback_wallets')) {
        return { ok: false, balance: 0 };
      }
      throw updateError;
    }

    if (updated) {
      const updatedNum = Number(updated.balance);
      return { ok: true, balance: Number.isFinite(updatedNum) ? roundMoney(updatedNum) : next };
    }
  }

  return { ok: false, balance: await getWalletBalance(clientId) };
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

  const { data, error } = await supabase
    .from('cashback_transactions')
    .upsert(payload, {
      onConflict: 'queue_entry_id,kind',
      ignoreDuplicates: true,
    })
    .select('id, client_id, queue_entry_id, kind, amount, created_at');

  if (error) {
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
  const total = await getServicesTotal(serviceIds);
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
  spendCashbackForQueueEntry,
  awardCashbackForCompletedQueueEntry,
};
