const { db } = require('../config/postgres');

const PURCHASE_STATUSES = new Set(['draft', 'ordered', 'received', 'cancelled']);

const normalizeText = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text || null;
};

const normalizeId = (value) => {
  const text = normalizeText(value);
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

const parseNumber = (value, fallback = 0) => {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const parseNonNegativeNumber = (value, fallback = 0) => {
  const number = parseNumber(value, fallback);
  return number !== null && number >= 0 ? number : null;
};

const parseDateTime = (value, fallback = new Date()) => {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const isMissingWarehouseTable = (error) => {
  const code = String(error?.code || '').trim();
  const message = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return code === '42P01'
    || ['warehouse_positions', 'warehouse_templates', 'warehouse_stocks', 'warehouse_purchases']
      .some((table) => message.includes(table) && (
        message.includes('does not exist')
        || message.includes('not found')
        || message.includes('schema cache')
      ));
};

const migrationHint = (res, error) => res.status(501).json({
  error: 'Warehouse tables are missing',
  hint: 'Apply db/postgres/warehouse.sql on the backend database.',
  details: error?.message,
});

const sendError = (res, error) => {
  if (isMissingWarehouseTable(error)) return migrationHint(res, error);
  return res.status(500).json({ error: error.message || 'Internal server error' });
};

const pagination = (query = {}) => ({
  limit: Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 500),
  offset: Math.max(parseInt(query.offset, 10) || 0, 0),
});

const rowCount = (result) => Number(result.rows[0]?.count || 0);

const positionItem = (row) => ({
  category: row?.category || null,
  created_at: row?.created_at || null,
  id: row?.id,
  is_active: row?.is_active ?? null,
  metadata: row?.metadata || {},
  min_quantity: Number(row?.min_quantity || 0),
  name: row?.name || null,
  sku: row?.sku || null,
  unit: row?.unit || null,
  updated_at: row?.updated_at || null,
});

const templateItem = (row) => ({
  created_at: row?.created_at || null,
  description: row?.description || null,
  id: row?.id,
  is_active: row?.is_active ?? null,
  items_count: Number(row?.items_count || 0),
  metadata: row?.metadata || {},
  name: row?.name || null,
  updated_at: row?.updated_at || null,
});

const stockItem = (row) => ({
  available_quantity: Number(row?.available_quantity || 0),
  branch: row?.branch_id ? {
    id: row.branch_id,
    name: row.branch_name || null,
  } : null,
  branch_id: row?.branch_id || null,
  id: row?.id,
  position: {
    category: row?.category || null,
    id: row?.position_id,
    min_quantity: Number(row?.min_quantity || 0),
    name: row?.position_name || null,
    sku: row?.sku || null,
    unit: row?.unit || null,
  },
  position_id: row?.position_id,
  quantity: Number(row?.quantity || 0),
  reserved_quantity: Number(row?.reserved_quantity || 0),
  updated_at: row?.updated_at || null,
});

const purchaseItem = (row) => ({
  branch: row?.branch_id ? {
    id: row.branch_id,
    name: row.branch_name || null,
  } : null,
  branch_id: row?.branch_id || null,
  created_at: row?.created_at || null,
  id: row?.id,
  items_count: Number(row?.items_count || 0),
  metadata: row?.metadata || {},
  purchased_at: row?.purchased_at || null,
  status: row?.status || null,
  supplier_name: row?.supplier_name || null,
  total_amount: Number(row?.total_amount || 0),
  updated_at: row?.updated_at || null,
});

const normalizePositionPayload = (body = {}, { partial = false } = {}) => {
  const payload = {};

  if (body.name !== undefined) {
    const name = normalizeText(body.name);
    if (!name) return { error: 'name is required' };
    payload.name = name;
  } else if (!partial) {
    return { error: 'name is required' };
  }

  for (const key of ['sku', 'unit', 'category']) {
    if (body[key] !== undefined) payload[key] = normalizeText(body[key]);
  }

  if (body.min_quantity !== undefined) {
    const minQuantity = parseNonNegativeNumber(body.min_quantity, null);
    if (minQuantity === null) return { error: 'min_quantity must be a non-negative number' };
    payload.min_quantity = minQuantity;
  }

  if (body.is_active !== undefined) {
    const isActive = parseBoolean(body.is_active, null);
    if (isActive === null) return { error: 'is_active must be a boolean' };
    payload.is_active = isActive;
  } else if (!partial) {
    payload.is_active = true;
  }

  if (body.metadata !== undefined) {
    payload.metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata
      : {};
  }

  if (!partial && !payload.unit) payload.unit = 'pcs';
  return { payload };
};

const normalizeTemplatePayload = (body = {}, { partial = false } = {}) => {
  const payload = {};

  if (body.name !== undefined) {
    const name = normalizeText(body.name);
    if (!name) return { error: 'name is required' };
    payload.name = name;
  } else if (!partial) {
    return { error: 'name is required' };
  }

  if (body.description !== undefined) payload.description = normalizeText(body.description);

  if (body.is_active !== undefined) {
    const isActive = parseBoolean(body.is_active, null);
    if (isActive === null) return { error: 'is_active must be a boolean' };
    payload.is_active = isActive;
  } else if (!partial) {
    payload.is_active = true;
  }

  if (body.metadata !== undefined) {
    payload.metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata
      : {};
  }

  return { payload };
};

const normalizeTemplateItems = (items) => {
  if (items === undefined) return { items: undefined };
  if (!Array.isArray(items)) return { error: 'items must be an array' };

  const normalized = [];
  for (const [index, item] of items.entries()) {
    const quantity = parseNonNegativeNumber(item?.quantity, 1);
    if (quantity === null) return { error: `items[${index}].quantity must be a non-negative number` };
    normalized.push({
      metadata: item?.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? item.metadata : {},
      name: normalizeText(item?.name),
      position_id: normalizeId(item?.position_id),
      quantity,
      sku: normalizeText(item?.sku),
      sort_order: Number.isInteger(Number(item?.sort_order)) ? Number(item.sort_order) : index,
      unit: normalizeText(item?.unit) || 'pcs',
    });
  }

  return { items: normalized };
};

const replaceTemplateItems = async (templateId, items) => {
  if (items === undefined) return;

  await db.query('delete from warehouse_template_items where template_id = $1', [templateId]);

  for (const item of items) {
    await db.query(
      `insert into warehouse_template_items
       (template_id, position_id, name, sku, unit, quantity, sort_order, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        templateId,
        item.position_id,
        item.name,
        item.sku,
        item.unit,
        item.quantity,
        item.sort_order,
        item.metadata,
      ]
    );
  }
};

const loadTemplateItems = async (templateId) => {
  const result = await db.query(
    `select ti.id, ti.template_id, ti.position_id, ti.name, ti.sku, ti.unit, ti.quantity, ti.sort_order, ti.metadata, ti.created_at,
            p.name as position_name, p.category, p.min_quantity
     from warehouse_template_items ti
     left join warehouse_positions p on p.id = ti.position_id
     where ti.template_id = $1
     order by ti.sort_order asc, ti.created_at asc`,
    [templateId]
  );

  return result.rows.map((row) => ({
    category: row.category || null,
    created_at: row.created_at || null,
    id: row.id,
    metadata: row.metadata || {},
    min_quantity: Number(row.min_quantity || 0),
    name: row.name || row.position_name || null,
    position_id: row.position_id || null,
    position_name: row.position_name || null,
    quantity: Number(row.quantity || 0),
    sku: row.sku || null,
    sort_order: Number(row.sort_order || 0),
    template_id: row.template_id,
    unit: row.unit || null,
  }));
};

const updateStockQuantity = async ({ branchId, positionId, quantityDelta }) => {
  if (!positionId || !quantityDelta) return;

  const params = [branchId, positionId, quantityDelta];
  const existing = await db.query(
    `select id
     from warehouse_stocks
     where (($1::uuid is null and branch_id is null) or branch_id = $1::uuid)
       and position_id = $2
     limit 1`,
    [branchId, positionId]
  );

  if (existing.rows[0]) {
    await db.query(
      `update warehouse_stocks
       set quantity = greatest(0, quantity + $1::numeric), updated_at = now()
       where id = $2`,
      [quantityDelta, existing.rows[0].id]
    );
    return;
  }

  await db.query(
    `insert into warehouse_stocks (branch_id, position_id, quantity, reserved_quantity)
     values ($1, $2, greatest(0, $3::numeric), 0)`,
    params
  );
};

const ensurePositionForPurchaseItem = async (item) => {
  const positionId = normalizeId(item?.position_id);
  if (positionId) return positionId;

  const sku = normalizeText(item?.sku);
  if (sku) {
    const existing = await db.query(
      'select id from warehouse_positions where sku = $1 limit 1',
      [sku]
    );
    if (existing.rows[0]) return existing.rows[0].id;
  }

  const name = normalizeText(item?.name);
  if (!name) return null;

  const created = await db.query(
    `insert into warehouse_positions (name, sku, unit, category, is_active)
     values ($1, $2, $3, $4, true)
     returning id`,
    [name, sku, normalizeText(item?.unit) || 'pcs', normalizeText(item?.category)]
  );
  return created.rows[0]?.id || null;
};

const normalizePurchaseItems = (items) => {
  if (!Array.isArray(items) || !items.length) return { error: 'items must be a non-empty array' };

  const normalized = [];
  for (const [index, item] of items.entries()) {
    const quantity = parseNonNegativeNumber(item?.quantity, null);
    const unitCost = parseNonNegativeNumber(item?.unit_cost ?? item?.price, 0);
    const explicitTotal = item?.total_amount === undefined ? undefined : parseNonNegativeNumber(item.total_amount, null);
    if (quantity === null || quantity <= 0) return { error: `items[${index}].quantity must be a positive number` };
    if (unitCost === null) return { error: `items[${index}].unit_cost must be a non-negative number` };
    if (explicitTotal === null) return { error: `items[${index}].total_amount must be a non-negative number` };

    normalized.push({
      category: normalizeText(item?.category),
      metadata: item?.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? item.metadata : {},
      name: normalizeText(item?.name),
      position_id: normalizeId(item?.position_id),
      quantity,
      sku: normalizeText(item?.sku),
      total_amount: explicitTotal === undefined ? Number((quantity * unitCost).toFixed(2)) : explicitTotal,
      unit: normalizeText(item?.unit) || 'pcs',
      unit_cost: unitCost,
    });
  }

  return { items: normalized };
};

const loadPurchaseItems = async (purchaseId) => {
  const result = await db.query(
    `select pi.id, pi.purchase_id, pi.position_id, pi.name, pi.sku, pi.unit, pi.quantity, pi.unit_cost,
            pi.total_amount, pi.metadata, pi.created_at, p.name as position_name, p.category
     from warehouse_purchase_items pi
     left join warehouse_positions p on p.id = pi.position_id
     where pi.purchase_id = $1
     order by pi.created_at asc`,
    [purchaseId]
  );

  return result.rows.map((row) => ({
    category: row.category || null,
    created_at: row.created_at || null,
    id: row.id,
    metadata: row.metadata || {},
    name: row.name || row.position_name || null,
    position_id: row.position_id || null,
    position_name: row.position_name || null,
    purchase_id: row.purchase_id,
    quantity: Number(row.quantity || 0),
    sku: row.sku || null,
    total_amount: Number(row.total_amount || 0),
    unit: row.unit || null,
    unit_cost: Number(row.unit_cost || 0),
  }));
};

class Warehouse {
  async summary(req, res) {
    try {
      const branchId = normalizeId(req.query?.branch_id);
      const lowOnlyParams = branchId ? [branchId] : [];
      const stockWhere = branchId ? 'where s.branch_id = $1' : '';

      const [positions, templates, lowStocks, purchases] = await Promise.all([
        db.query('select count(*)::int as count from warehouse_positions where is_active = true'),
        db.query('select count(*)::int as count from warehouse_templates where is_active = true'),
        db.query(
          `select count(*)::int as count
           from warehouse_stocks s
           join warehouse_positions p on p.id = s.position_id
           ${stockWhere}
           ${stockWhere ? 'and' : 'where'} s.quantity <= p.min_quantity`,
          lowOnlyParams
        ),
        db.query(
          `select coalesce(sum(total_amount), 0)::numeric as total
           from warehouse_purchases
           where status <> 'cancelled'
             and purchased_at >= date_trunc('month', now())`
        ),
      ]);

      return res.json({
        positions: rowCount(positions),
        templates: rowCount(templates),
        low_stock_positions: rowCount(lowStocks),
        purchases_month_total: Number(purchases.rows[0]?.total || 0),
      });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async listPositions(req, res) {
    try {
      const { limit, offset } = pagination(req.query);
      const includeInactive = parseBoolean(req.query?.include_inactive, false);
      const search = normalizeText(req.query?.search);
      const category = normalizeText(req.query?.category);
      const where = [];
      const params = [];

      if (!includeInactive) where.push('is_active = true');
      if (category) {
        params.push(category);
        where.push(`category = $${params.length}`);
      }
      if (search) {
        params.push(`%${search}%`);
        where.push(`(name ilike $${params.length} or sku ilike $${params.length})`);
      }

      const whereSql = where.length ? `where ${where.join(' and ')}` : '';
      const count = await db.query(`select count(*)::int as count from warehouse_positions ${whereSql}`, params);
      params.push(limit, offset);
      const result = await db.query(
        `select *
         from warehouse_positions
         ${whereSql}
         order by name asc
         limit $${params.length - 1} offset $${params.length}`,
        params
      );

      return res.json({ items: result.rows.map(positionItem), total: rowCount(count) });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async createPosition(req, res) {
    const { payload, error: payloadError } = normalizePositionPayload(req.body || {});
    if (payloadError) return res.status(400).json({ error: payloadError });

    try {
      const result = await db.query(
        `insert into warehouse_positions (name, sku, unit, category, min_quantity, is_active, metadata)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning *`,
        [
          payload.name,
          payload.sku || null,
          payload.unit || 'pcs',
          payload.category || null,
          payload.min_quantity || 0,
          payload.is_active,
          payload.metadata || {},
        ]
      );

      return res.status(201).json({ item: positionItem(result.rows[0]) });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async updatePosition(req, res) {
    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Position id is required' });

    const { payload, error: payloadError } = normalizePositionPayload(req.body || {}, { partial: true });
    if (payloadError) return res.status(400).json({ error: payloadError });
    if (!Object.keys(payload).length) return res.status(400).json({ error: 'No fields to update' });

    try {
      payload.updated_at = new Date().toISOString();
      const keys = Object.keys(payload);
      const values = keys.map((key) => payload[key]);
      const setSql = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
      const result = await db.query(
        `update warehouse_positions
         set ${setSql}
         where id = $${keys.length + 1}
         returning *`,
        [...values, id]
      );

      if (!result.rows[0]) return res.status(404).json({ error: 'Position not found' });
      return res.json({ item: positionItem(result.rows[0]) });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async deletePosition(req, res) {
    const id = normalizeId(req.params?.id || req.query?.id || req.body?.id);
    if (!id) return res.status(400).json({ error: 'Position id is required' });

    try {
      const result = await db.query('delete from warehouse_positions where id = $1 returning id', [id]);
      if (!result.rows[0]) return res.status(404).json({ error: 'Position not found' });
      return res.json({ deleted: true, id: result.rows[0].id });
    } catch (error) {
      if (String(error.code) === '23503') {
        const result = await db.query(
          `update warehouse_positions
           set is_active = false, updated_at = now()
           where id = $1
           returning id`,
          [id]
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'Position not found' });
        return res.json({ deleted: true, id: result.rows[0].id, soft_deleted: true });
      }
      return sendError(res, error);
    }
  }

  async listTemplates(req, res) {
    try {
      const { limit, offset } = pagination(req.query);
      const includeInactive = parseBoolean(req.query?.include_inactive, false);
      const whereSql = includeInactive ? '' : 'where t.is_active = true';

      const count = await db.query(`select count(*)::int as count from warehouse_templates t ${whereSql}`);
      const result = await db.query(
        `select t.*, count(ti.id)::int as items_count
         from warehouse_templates t
         left join warehouse_template_items ti on ti.template_id = t.id
         ${whereSql}
         group by t.id
         order by t.name asc
         limit $1 offset $2`,
        [limit, offset]
      );

      return res.json({ items: result.rows.map(templateItem), total: rowCount(count) });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async getTemplate(req, res) {
    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Template id is required' });

    try {
      const result = await db.query(
        `select t.*, count(ti.id)::int as items_count
         from warehouse_templates t
         left join warehouse_template_items ti on ti.template_id = t.id
         where t.id = $1
         group by t.id`,
        [id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Template not found' });
      return res.json({ item: { ...templateItem(result.rows[0]), items: await loadTemplateItems(id) } });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async createTemplate(req, res) {
    const { payload, error: payloadError } = normalizeTemplatePayload(req.body || {});
    if (payloadError) return res.status(400).json({ error: payloadError });
    const { items, error: itemsError } = normalizeTemplateItems(req.body?.items);
    if (itemsError) return res.status(400).json({ error: itemsError });

    try {
      const result = await db.query(
        `insert into warehouse_templates (name, description, is_active, metadata)
         values ($1, $2, $3, $4)
         returning *`,
        [payload.name, payload.description || null, payload.is_active, payload.metadata || {}]
      );
      const template = result.rows[0];
      await replaceTemplateItems(template.id, items || []);
      const storedItems = await loadTemplateItems(template.id);

      return res.status(201).json({
        item: { ...templateItem({ ...template, items_count: storedItems.length }), items: storedItems },
      });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async updateTemplate(req, res) {
    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Template id is required' });

    const { payload, error: payloadError } = normalizeTemplatePayload(req.body || {}, { partial: true });
    if (payloadError) return res.status(400).json({ error: payloadError });
    const { items, error: itemsError } = normalizeTemplateItems(req.body?.items);
    if (itemsError) return res.status(400).json({ error: itemsError });
    if (!Object.keys(payload).length && items === undefined) return res.status(400).json({ error: 'No fields to update' });

    try {
      let template;
      if (Object.keys(payload).length) {
        payload.updated_at = new Date().toISOString();
        const keys = Object.keys(payload);
        const values = keys.map((key) => payload[key]);
        const setSql = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
        const result = await db.query(
          `update warehouse_templates
           set ${setSql}
           where id = $${keys.length + 1}
           returning *`,
          [...values, id]
        );
        template = result.rows[0];
      } else {
        const result = await db.query('select * from warehouse_templates where id = $1', [id]);
        template = result.rows[0];
      }

      if (!template) return res.status(404).json({ error: 'Template not found' });
      await replaceTemplateItems(id, items);
      const storedItems = await loadTemplateItems(id);

      return res.json({
        item: { ...templateItem({ ...template, items_count: storedItems.length }), items: storedItems },
      });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async deleteTemplate(req, res) {
    const id = normalizeId(req.params?.id || req.query?.id || req.body?.id);
    if (!id) return res.status(400).json({ error: 'Template id is required' });

    try {
      const result = await db.query(
        `update warehouse_templates
         set is_active = false, updated_at = now()
         where id = $1
         returning id`,
        [id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Template not found' });
      return res.json({ deleted: true, id: result.rows[0].id, soft_deleted: true });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async listStocks(req, res) {
    try {
      const { limit, offset } = pagination(req.query);
      const branchId = normalizeId(req.query?.branch_id);
      const lowOnly = parseBoolean(req.query?.low_only, false);
      const params = [];
      const where = [];

      if (branchId) {
        params.push(branchId);
        where.push(`s.branch_id = $${params.length}`);
      }
      if (lowOnly) where.push('s.quantity <= p.min_quantity');

      const whereSql = where.length ? `where ${where.join(' and ')}` : '';
      const count = await db.query(
        `select count(*)::int as count
         from warehouse_stocks s
         join warehouse_positions p on p.id = s.position_id
         ${whereSql}`,
        params
      );
      params.push(limit, offset);
      const result = await db.query(
        `select s.id, s.branch_id, s.position_id, s.quantity, s.reserved_quantity,
                greatest(0, s.quantity - s.reserved_quantity) as available_quantity,
                s.updated_at, p.name as position_name, p.sku, p.unit, p.category, p.min_quantity,
                b.name as branch_name
         from warehouse_stocks s
         join warehouse_positions p on p.id = s.position_id
         left join branches b on b.id = s.branch_id
         ${whereSql}
         order by b.name asc nulls first, p.name asc
         limit $${params.length - 1} offset $${params.length}`,
        params
      );

      return res.json({ items: result.rows.map(stockItem), total: rowCount(count) });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async setStock(req, res) {
    const branchId = normalizeId(req.body?.branch_id);
    const positionId = normalizeId(req.body?.position_id);
    const quantity = parseNonNegativeNumber(req.body?.quantity, null);
    const reservedQuantity = parseNonNegativeNumber(req.body?.reserved_quantity, 0);

    if (!positionId) return res.status(400).json({ error: 'position_id is required' });
    if (quantity === null) return res.status(400).json({ error: 'quantity must be a non-negative number' });
    if (reservedQuantity === null) return res.status(400).json({ error: 'reserved_quantity must be a non-negative number' });

    try {
      const existing = await db.query(
        `select id
         from warehouse_stocks
         where (($1::uuid is null and branch_id is null) or branch_id = $1::uuid)
           and position_id = $2
         limit 1`,
        [branchId, positionId]
      );

      const result = existing.rows[0]
        ? await db.query(
          `update warehouse_stocks
           set quantity = $1, reserved_quantity = $2, updated_at = now()
           where id = $3
           returning id`,
          [quantity, reservedQuantity, existing.rows[0].id]
        )
        : await db.query(
          `insert into warehouse_stocks (branch_id, position_id, quantity, reserved_quantity)
           values ($1, $2, $3, $4)
           returning id`,
          [branchId, positionId, quantity, reservedQuantity]
        );

      return res.status(existing.rows[0] ? 200 : 201).json({ stock_id: result.rows[0].id });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async listPurchases(req, res) {
    try {
      const { limit, offset } = pagination(req.query);
      const branchId = normalizeId(req.query?.branch_id);
      const status = normalizeText(req.query?.status);
      const where = [];
      const params = [];

      if (branchId) {
        params.push(branchId);
        where.push(`p.branch_id = $${params.length}`);
      }
      if (status) {
        params.push(status);
        where.push(`p.status = $${params.length}`);
      }

      const whereSql = where.length ? `where ${where.join(' and ')}` : '';
      const count = await db.query(`select count(*)::int as count from warehouse_purchases p ${whereSql}`, params);
      params.push(limit, offset);
      const result = await db.query(
        `select p.*, b.name as branch_name, count(pi.id)::int as items_count
         from warehouse_purchases p
         left join branches b on b.id = p.branch_id
         left join warehouse_purchase_items pi on pi.purchase_id = p.id
         ${whereSql}
         group by p.id, b.name
         order by p.purchased_at desc
         limit $${params.length - 1} offset $${params.length}`,
        params
      );

      return res.json({ items: result.rows.map(purchaseItem), total: rowCount(count) });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async getPurchase(req, res) {
    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Purchase id is required' });

    try {
      const result = await db.query(
        `select p.*, b.name as branch_name, count(pi.id)::int as items_count
         from warehouse_purchases p
         left join branches b on b.id = p.branch_id
         left join warehouse_purchase_items pi on pi.purchase_id = p.id
         where p.id = $1
         group by p.id, b.name`,
        [id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Purchase not found' });
      return res.json({ item: { ...purchaseItem(result.rows[0]), items: await loadPurchaseItems(id) } });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async createPurchase(req, res) {
    const branchId = normalizeId(req.body?.branch_id);
    const status = normalizeText(req.body?.status) || 'received';
    const purchasedAt = parseDateTime(req.body?.purchased_at, new Date());
    const { items, error: itemsError } = normalizePurchaseItems(req.body?.items);

    if (!PURCHASE_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid purchase status' });
    if (!purchasedAt) return res.status(400).json({ error: 'purchased_at must be a valid date/time' });
    if (itemsError) return res.status(400).json({ error: itemsError });

    try {
      const preparedItems = [];
      for (const item of items) {
        preparedItems.push({
          ...item,
          position_id: await ensurePositionForPurchaseItem(item),
        });
      }

      const calculatedTotal = preparedItems.reduce((sum, item) => sum + item.total_amount, 0);
      const explicitTotal = req.body?.total_amount === undefined
        ? undefined
        : parseNonNegativeNumber(req.body.total_amount, null);
      if (explicitTotal === null) return res.status(400).json({ error: 'total_amount must be a non-negative number' });

      const purchaseResult = await db.query(
        `insert into warehouse_purchases
         (branch_id, supplier_name, purchased_at, status, total_amount, metadata)
         values ($1, $2, $3, $4, $5, $6)
         returning *`,
        [
          branchId,
          normalizeText(req.body?.supplier_name),
          purchasedAt.toISOString(),
          status,
          explicitTotal === undefined ? Number(calculatedTotal.toFixed(2)) : explicitTotal,
          req.body?.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
            ? req.body.metadata
            : {},
        ]
      );
      const purchase = purchaseResult.rows[0];

      for (const item of preparedItems) {
        await db.query(
          `insert into warehouse_purchase_items
           (purchase_id, position_id, name, sku, unit, quantity, unit_cost, total_amount, metadata)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            purchase.id,
            item.position_id,
            item.name,
            item.sku,
            item.unit,
            item.quantity,
            item.unit_cost,
            item.total_amount,
            item.metadata,
          ]
        );

        if (status === 'received' && item.position_id) {
          await updateStockQuantity({
            branchId,
            positionId: item.position_id,
            quantityDelta: item.quantity,
          });
        }
      }

      return res.status(201).json({
        item: { ...purchaseItem({ ...purchase, items_count: preparedItems.length }), items: await loadPurchaseItems(purchase.id) },
      });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async updatePurchase(req, res) {
    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Purchase id is required' });

    const update = {};
    if (req.body?.branch_id !== undefined) update.branch_id = normalizeId(req.body.branch_id);
    if (req.body?.supplier_name !== undefined) update.supplier_name = normalizeText(req.body.supplier_name);
    if (req.body?.purchased_at !== undefined) {
      const purchasedAt = parseDateTime(req.body.purchased_at, null);
      if (!purchasedAt) return res.status(400).json({ error: 'purchased_at must be a valid date/time' });
      update.purchased_at = purchasedAt.toISOString();
    }
    if (req.body?.status !== undefined) {
      const status = normalizeText(req.body.status);
      if (!PURCHASE_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid purchase status' });
      update.status = status;
    }
    if (req.body?.total_amount !== undefined) {
      const total = parseNonNegativeNumber(req.body.total_amount, null);
      if (total === null) return res.status(400).json({ error: 'total_amount must be a non-negative number' });
      update.total_amount = total;
    }
    if (req.body?.metadata !== undefined) {
      update.metadata = req.body.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
        ? req.body.metadata
        : {};
    }
    if (!Object.keys(update).length) return res.status(400).json({ error: 'No fields to update' });

    try {
      update.updated_at = new Date().toISOString();
      const keys = Object.keys(update);
      const values = keys.map((key) => update[key]);
      const setSql = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
      const result = await db.query(
        `update warehouse_purchases
         set ${setSql}
         where id = $${keys.length + 1}
         returning *`,
        [...values, id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Purchase not found' });
      return res.json({ item: { ...purchaseItem(result.rows[0]), items: await loadPurchaseItems(id) } });
    } catch (error) {
      return sendError(res, error);
    }
  }

  async deletePurchase(req, res) {
    const id = normalizeId(req.params?.id || req.query?.id || req.body?.id);
    if (!id) return res.status(400).json({ error: 'Purchase id is required' });

    try {
      const result = await db.query('delete from warehouse_purchases where id = $1 returning id', [id]);
      if (!result.rows[0]) return res.status(404).json({ error: 'Purchase not found' });
      return res.json({ deleted: true, id: result.rows[0].id });
    } catch (error) {
      return sendError(res, error);
    }
  }
}

module.exports = new Warehouse();
