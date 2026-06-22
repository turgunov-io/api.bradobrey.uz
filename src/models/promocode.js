const { db } = require('../config/postgres');

const normalizeCode = (code = '') => String(code).trim().toUpperCase();

const normalizeId = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text || null;
};

const formatDiscount = (promo) => {
  if (!promo) return '';
  const value = Number(promo.discount_value);
  if (promo.discount_type === 'percentage') return `${value}%`;
  return `${value}`;
};

const calcDiscountedTotal = (total, promo) => {
  const numTotal = Number(total);
  if (!Number.isFinite(numTotal) || !promo) return null;
  const value = Number(promo.discount_value);
  if (!Number.isFinite(value) || value <= 0) return numTotal;
  let discounted = numTotal;
  if (promo.discount_type === 'percentage') {
    discounted = numTotal - (numTotal * value) / 100;
  } else {
    discounted = numTotal - value;
  }
  return Math.max(0, Number(discounted.toFixed(2)));
};

const isMissingColumnError = (error, column) => {
  const message = String(error?.message || error?.details || '').toLowerCase();
  return Boolean(error) && message.includes(column.toLowerCase()) && (
    message.includes('does not exist') ||
    message.includes('could not find') ||
    message.includes('schema cache')
  );
};

const normalizeDiscountType = (value) => {
  const type = String(value || '').trim().toLowerCase();

  if (type === 'percent') return 'percentage';
  if (type === 'amount') return 'fixed';

  return type;
};

const normalizeStatus = (value) => String(value || 'active').trim().toLowerCase();

class PromoCodes {
  async validate(req, res) {
    const { code, user_id, order_total } = req.body || {};
    if (!code) return res.status(400).json({ success: false, message: 'code is required' });

    const promo = await this.fetchPromo(code);
    if (promo.error) return res.status(500).json({ success: false, message: promo.error });
    if (!promo.data) return res.status(404).json({ success: false, message: 'Promo code not found' });

    const allowed = this.ensureAllowed(promo.data);
    if (!allowed.ok) return res.status(400).json({ success: false, message: allowed.message });

    const discounted_total = calcDiscountedTotal(order_total, promo.data);

    return res.json({
      success: true,
      discount_type: promo.data.discount_type,
      discount_value: Number(promo.data.discount_value),
      discount_label: formatDiscount(promo.data),
      discounted_total,
      message: 'Promo code valid',
    });
  }

  async use(req, res) {
    const { promo_code, user_id, user_name, phone, order_id } = req.body || {};
    if (!promo_code) return res.status(400).json({ success: false, message: 'promo_code is required' });

    const promo = await this.fetchPromo(promo_code);
    if (promo.error) return res.status(500).json({ success: false, message: promo.error });
    if (!promo.data) return res.status(404).json({ success: false, message: 'Promo code not found' });

    const allowed = this.ensureAllowed(promo.data);
    if (!allowed.ok) return res.status(400).json({ success: false, message: allowed.message });

    const { error: insertError } = await db.from('promo_code_usage').insert({
      promo_code_id: promo.data.id,
      user_id: user_id || null,
      user_name: user_name || null,
      phone: phone || null,
      order_id: order_id || null,
    });

    if (insertError) {
      return res.status(500).json({ success: false, message: insertError.message });
    }

    let updatedPromo = promo.data;

    if (!promo.data.is_unlimited) {
      const nextCount = (promo.data.used_count || 0) + 1;
      if (nextCount > promo.data.usage_limit) {
        return res.status(409).json({ success: false, message: 'Promo code limit reached during update' });
      }

      const { data: updated, error: updateError } = await db
        .from('promo_codes')
        .update({ used_count: nextCount })
        .eq('id', promo.data.id)
        .select()
        .maybeSingle();

      if (updateError) {
        return res.status(500).json({ success: false, message: updateError.message });
      }

      if (updated) updatedPromo = updated;
    }

    return res.json({
      success: true,
      promo_code: updatedPromo.code,
      used_count: updatedPromo.used_count,
      usage_limit: updatedPromo.is_unlimited ? null : updatedPromo.usage_limit,
      is_unlimited: updatedPromo.is_unlimited,
      message: 'Promo code usage recorded',
    });
  }

  async stats(req, res) {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    const promo = await this.fetchPromoById(id);
    if (promo.error) return res.status(500).json({ error: promo.error });
    if (!promo.data) return res.status(404).json({ error: 'Promo code not found' });

    const { data: usage, error: usageError } = await db
      .from('promo_code_usage')
      .select('user_name, phone, order_id, used_at')
      .eq('promo_code_id', promo.data.id)
      .order('used_at', { ascending: false });

    if (usageError) return res.status(500).json({ error: usageError.message });

    return res.json({
      code: promo.data.code,
      discount: formatDiscount(promo.data),
      discount_type: promo.data.discount_type,
      discount_value: Number(promo.data.discount_value),
      usage_limit: promo.data.is_unlimited ? null : promo.data.usage_limit,
      used_count: promo.data.used_count,
      status: promo.data.status,
      is_unlimited: promo.data.is_unlimited,
      users: (usage || []).map((u) => ({
        name: u.user_name,
        phone: u.phone,
        order_id: u.order_id,
        used_at: u.used_at,
      })),
    });
  }

  async list(req, res) {
    const { data, error } = await db
      .from('promo_codes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const items = (data || []).map((row) => ({
      ...row,
      discount: formatDiscount(row),
      remaining: row.is_unlimited ? null : Math.max((row.usage_limit || 0) - (row.used_count || 0), 0),
    }));

    return res.json({ items, count: items.length });
  }

  async create(req, res) {
    const parsed = this.parseWritePayload(req.body);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    const payload = {
      ...parsed.data,
      used_count: 0,
    };

    let { data, error } = await db
      .from('promo_codes')
      .insert(payload)
      .select()
      .maybeSingle();

    if (isMissingColumnError(error, 'marketplace_barbershop_id')) {
      delete payload.marketplace_barbershop_id;
      ({ data, error } = await db
        .from('promo_codes')
        .insert(payload)
        .select()
        .maybeSingle());
    }

    if (error) return res.status(500).json({ error: error.message });

    return res.status(201).json({
      promo_code: data,
      message: 'Promo code created',
    });
  }

  async update(req, res) {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    const promo = await this.fetchPromoById(id);
    if (promo.error) return res.status(500).json({ error: promo.error });
    if (!promo.data) return res.status(404).json({ error: 'Promo code not found' });

    const parsed = this.parseWritePayload(req.body, { currentPromo: promo.data });
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    let updatePayload = parsed.data;
    let { data, error } = await db
      .from('promo_codes')
      .update(updatePayload)
      .eq('id', promo.data.id)
      .select()
      .maybeSingle();

    if (isMissingColumnError(error, 'marketplace_barbershop_id')) {
      updatePayload = { ...parsed.data };
      delete updatePayload.marketplace_barbershop_id;
      ({ data, error } = await db
        .from('promo_codes')
        .update(updatePayload)
        .eq('id', promo.data.id)
        .select()
        .maybeSingle());
    }

    if (error) return res.status(500).json({ error: error.message });

    return res.json({
      promo_code: data,
      message: 'Promo code updated',
    });
  }

  async remove(req, res) {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    const promo = await this.fetchPromoById(id);
    if (promo.error) return res.status(500).json({ error: promo.error });
    if (!promo.data) return res.status(404).json({ error: 'Promo code not found' });

    const { error: usageError } = await db
      .from('promo_code_usage')
      .delete()
      .eq('promo_code_id', promo.data.id);

    if (usageError) return res.status(500).json({ error: usageError.message });

    const { error: deleteError } = await db
      .from('promo_codes')
      .delete()
      .eq('id', promo.data.id);

    if (deleteError) return res.status(500).json({ error: deleteError.message });

    return res.json({
      id: promo.data.id,
      message: 'Promo code deleted',
    });
  }

  async fetchPromo(rawCode) {
    const code = normalizeCode(rawCode);
    const { data, error } = await db
      .from('promo_codes')
      .select('*')
      .eq('code', code)
      .maybeSingle();

    return { data, error: error ? error.message : null };
  }

  async fetchPromoById(id) {
    const { data, error } = await db
      .from('promo_codes')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    return { data, error: error ? error.message : null };
  }

  parseWritePayload(body = {}, options = {}) {
    const currentPromo = options.currentPromo || null;
    const code = normalizeCode(body.code);
    const discountType = normalizeDiscountType(body.discount_type);
    const numericValue = Number(body.discount_value);
    const isUnlimited = Boolean(body.is_unlimited);
    const status = normalizeStatus(body.status);
    const marketplaceBarbershopId = body.marketplace_barbershop_id === undefined
      ? (currentPromo ? currentPromo.marketplace_barbershop_id || null : null)
      : normalizeId(body.marketplace_barbershop_id);
    const limit = body.usage_limit === null || body.usage_limit === undefined || body.usage_limit === ''
      ? null
      : Number(body.usage_limit);

    if (!code || !discountType || body.discount_value === undefined || body.discount_value === null || body.discount_value === '') {
      return { error: 'code, discount_type, and discount_value are required' };
    }

    if (!['percentage', 'fixed'].includes(discountType)) {
      return { error: 'discount_type must be percentage or fixed' };
    }

    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return { error: 'discount_value must be a positive number' };
    }

    if (!['active', 'inactive'].includes(status)) {
      return { error: 'status must be active or inactive' };
    }

    if (!isUnlimited) {
      if (!Number.isFinite(limit) || limit <= 0) {
        return { error: 'usage_limit must be a positive number when not unlimited' };
      }

      if (currentPromo && limit < Number(currentPromo.used_count || 0)) {
        return { error: 'usage_limit cannot be less than used_count' };
      }
    }

    return {
      data: {
        code,
        discount_type: discountType,
        discount_value: numericValue,
        usage_limit: isUnlimited ? null : limit,
        is_unlimited: Boolean(isUnlimited),
        status,
        marketplace_barbershop_id: marketplaceBarbershopId,
      },
      error: null,
    };
  }

  ensureAllowed(promo) {
    if (!promo) return { ok: false, message: 'Promo code not found' };
    if (promo.status !== 'active') return { ok: false, message: 'Promo code inactive' };
    if (!promo.is_unlimited && promo.used_count >= promo.usage_limit) {
      return { ok: false, message: 'Promo code expired or limit reached' };
    }
    return { ok: true };
  }
}

module.exports = new PromoCodes();
