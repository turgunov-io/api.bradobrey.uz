const { supabase } = require('../config/supabase');

const uniq = (items) => Array.from(new Set((items || []).filter(Boolean)));

const toNumberOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

async function enrichQueueEntriesWithBenefits(entries = []) {
  const items = Array.isArray(entries) ? entries : [];
  if (items.length === 0) return items;

  const orderIds = uniq(items.map((e) => e?.id).map((id) => (id ? String(id) : null)));
  const certificateIds = uniq(
    items.map((e) => e?.certificate_id).map((id) => (id ? String(id) : null))
  );

  const certificateById = new Map();
  if (certificateIds.length) {
    const { data, error } = await supabase
      .from('certificates')
      .select('id, code')
      .in('id', certificateIds);

    if (error) {
      console.error('Failed to fetch certificates for queue entries:', error.message);
    } else {
      for (const row of data || []) {
        if (row?.id) certificateById.set(String(row.id), row);
      }
    }
  }

  const usageByOrderId = new Map();
  if (orderIds.length) {
    const { data, error } = await supabase
      .from('promo_code_usage')
      .select('promo_code_id, order_id, used_at')
      .in('order_id', orderIds)
      .order('used_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch promo_code_usage for queue entries:', error.message);
    } else {
      for (const row of data || []) {
        const orderId = row?.order_id ? String(row.order_id) : null;
        if (!orderId) continue;
        if (!usageByOrderId.has(orderId)) usageByOrderId.set(orderId, row);
      }
    }
  }

  const promoCodeIds = uniq(
    Array.from(usageByOrderId.values())
      .map((u) => u?.promo_code_id)
      .map((id) => (id ? String(id) : null))
  );

  const promoById = new Map();
  if (promoCodeIds.length) {
    const { data, error } = await supabase
      .from('promo_codes')
      .select('id, code, discount_type, discount_value')
      .in('id', promoCodeIds);

    if (error) {
      console.error('Failed to fetch promo_codes for queue entries:', error.message);
    } else {
      for (const row of data || []) {
        if (row?.id) promoById.set(String(row.id), row);
      }
    }
  }

  return items.map((entry) => {
    const orderId = entry?.id ? String(entry.id) : null;
    const usage = orderId ? usageByOrderId.get(orderId) : null;
    const promo = usage?.promo_code_id ? promoById.get(String(usage.promo_code_id)) : null;

    const certificateId = entry?.certificate_id ? String(entry.certificate_id) : null;
    const certificate = certificateId ? certificateById.get(certificateId) : null;

    const used_certificate =
      entry?.payment_method === 'certificate' || Boolean(certificateId);
    const used_promo = Boolean(promo);

    return {
      ...entry,
      used_certificate,
      certificate_code: certificate?.code || null,
      used_promo,
      promo_code: promo?.code || null,
      promo_discount_type: promo?.discount_type || null,
      promo_discount_value: promo ? toNumberOrNull(promo.discount_value) : null,
    };
  });
}

module.exports = { enrichQueueEntriesWithBenefits };

