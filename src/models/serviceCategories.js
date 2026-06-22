const { db } = require('../config/postgres');

const CATEGORY_SELECT = 'id, branch_id, marketplace_barbershop_id, name, sort_order, is_active, created_at, updated_at';

const normalizeText = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text || null;
};

const normalizeId = (value) => {
  const text = String(value || '').trim();
  return text || null;
};

const parseBoolean = (value, fallback = undefined) => {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseInteger = (value, fallback = undefined) => {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number.parseInt(String(value), 10);
  return Number.isFinite(number) ? number : null;
};

const isMissingCategoriesTable = (error) => {
  const code = String(error?.code || '').trim();
  const message = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return code === '42P01'
    || code === 'PGRST205'
    || (message.includes('service_categories') && (
      message.includes('does not exist')
      || message.includes('not found')
      || message.includes('schema cache')
    ));
};

const migrationHint = (res, error) => res.status(501).json({
  error: 'service_categories table is missing',
  hint: 'Apply db/postgres/service_categories.sql on the backend database.',
  details: error?.message,
});

const categoryItem = (row, services = []) => ({
  ...row,
  services,
  title: row?.name || null,
});

const normalizePayload = (body = {}, { partial = false } = {}) => {
  const payload = {};

  if (body.name !== undefined || body.title !== undefined) {
    const name = normalizeText(body.name ?? body.title);
    if (!name) return { error: 'name is required' };
    payload.name = name;
  } else if (!partial) {
    return { error: 'name is required' };
  }

  if (body.branch_id !== undefined || body.object_id !== undefined) {
    payload.branch_id = normalizeId(body.branch_id ?? body.object_id);
  }

  if (body.marketplace_barbershop_id !== undefined) {
    payload.marketplace_barbershop_id = normalizeId(body.marketplace_barbershop_id);
  }

  if (body.sort_order !== undefined) {
    const sortOrder = parseInteger(body.sort_order, null);
    if (sortOrder === null) return { error: 'sort_order must be an integer' };
    payload.sort_order = sortOrder;
  } else if (!partial) {
    payload.sort_order = 0;
  }

  if (body.is_active !== undefined) {
    const isActive = parseBoolean(body.is_active, null);
    if (isActive === null) return { error: 'is_active must be a boolean' };
    payload.is_active = isActive;
  } else if (!partial) {
    payload.is_active = true;
  }

  return { payload };
};

const loadServicesForCategories = async (categories) => {
  const names = Array.from(new Set((categories || []).map((item) => item?.name).filter(Boolean)));
  if (!names.length) return new Map();

  const { data, error } = await db
    .from('services')
    .select('id, name, duration_minutes, base_price, category, image, is_active')
    .in('category', names);

  if (error) return new Map();

  const map = new Map();
  for (const service of data || []) {
    const key = service?.category;
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(service);
  }

  return map;
};

const syncServiceCategoryName = async ({ branchId, marketplaceBarbershopId, oldName, newName }) => {
  if (!oldName || oldName === newName) return null;

  let query = db
    .from('services')
    .update({ category: newName || null, updated_at: new Date().toISOString() })
    .eq('category', oldName);

  if (branchId) query = query.eq('branch_id', branchId);
  if (marketplaceBarbershopId) query = query.eq('marketplace_barbershop_id', marketplaceBarbershopId);

  const { error } = await query;
  if (error) throw new Error(error.message);
  return null;
};

class ServiceCategories {
  async list(req, res) {
    const includeInactive = parseBoolean(req.query?.include_inactive, true);
    const activeFilter = parseBoolean(req.query?.active, undefined);
    const branchId = normalizeId(req.query?.branch_id || req.query?.object_id);
    const marketplaceBarbershopId = normalizeId(req.query?.marketplace_barbershop_id);

    let query = db
      .from('service_categories')
      .select(CATEGORY_SELECT, { count: 'exact' });

    if (branchId) query = query.eq('branch_id', branchId);
    if (marketplaceBarbershopId) query = query.eq('marketplace_barbershop_id', marketplaceBarbershopId);
    if (activeFilter !== undefined) {
      query = query.eq('is_active', activeFilter);
    } else if (includeInactive === false) {
      query = query.eq('is_active', true);
    }

    const { data, error, count } = await query
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (error) {
      if (isMissingCategoriesTable(error)) return migrationHint(res, error);
      return res.status(500).json({ error: error.message });
    }

    const servicesByCategory = await loadServicesForCategories(data || []);
    const items = (data || []).map((row) => categoryItem(row, servicesByCategory.get(row.name) || []));

    return res.json({ items, total: count ?? items.length });
  }

  async create(req, res) {
    const { payload, error: payloadError } = normalizePayload(req.body || {});
    if (payloadError) return res.status(400).json({ error: payloadError });

    const { data, error } = await db
      .from('service_categories')
      .insert(payload)
      .select(CATEGORY_SELECT)
      .maybeSingle();

    if (error) {
      if (isMissingCategoriesTable(error)) return migrationHint(res, error);
      const status = error.code === '23505' ? 409 : 500;
      return res.status(status).json({ error: error.code === '23505' ? 'category already exists' : error.message });
    }

    return res.status(201).json({ item: categoryItem(data) });
  }

  async update(req, res) {
    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Category id is required' });

    const { payload, error: payloadError } = normalizePayload(req.body || {}, { partial: true });
    if (payloadError) return res.status(400).json({ error: payloadError });
    if (!Object.keys(payload).length) return res.status(400).json({ error: 'No fields to update' });

    const { data: existing, error: existingError } = await db
      .from('service_categories')
      .select(CATEGORY_SELECT)
      .eq('id', id)
      .maybeSingle();

    if (existingError) {
      if (isMissingCategoriesTable(existingError)) return migrationHint(res, existingError);
      return res.status(500).json({ error: existingError.message });
    }
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    const { data, error } = await db
      .from('service_categories')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(CATEGORY_SELECT)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Category not found' });

    try {
      await syncServiceCategoryName({
        branchId: data.branch_id,
        marketplaceBarbershopId: data.marketplace_barbershop_id,
        newName: data.name,
        oldName: existing.name,
      });
    } catch (syncError) {
      return res.status(500).json({ error: syncError.message });
    }

    return res.json({ item: categoryItem(data) });
  }

  async remove(req, res) {
    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Category id is required' });

    const { data: existing, error: existingError } = await db
      .from('service_categories')
      .select(CATEGORY_SELECT)
      .eq('id', id)
      .maybeSingle();

    if (existingError) {
      if (isMissingCategoriesTable(existingError)) return migrationHint(res, existingError);
      return res.status(500).json({ error: existingError.message });
    }
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    try {
      await syncServiceCategoryName({
        branchId: existing.branch_id,
        marketplaceBarbershopId: existing.marketplace_barbershop_id,
        newName: null,
        oldName: existing.name,
      });
    } catch (syncError) {
      return res.status(500).json({ error: syncError.message });
    }

    const { data, error } = await db
      .from('service_categories')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Category not found' });

    return res.json({ deleted: true, id: data.id });
  }
}

module.exports = new ServiceCategories();

