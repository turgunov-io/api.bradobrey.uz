const jwt = require('jsonwebtoken');
const { db } = require('../config/postgres');

const PRIVILEGED_ROLES = new Set(['admin_network', 'admin_branch', 'admin', 'super-manager']);
const EXPENSE_TYPE = 'expense';
const PERMISSIONS = {
  read: 'expenses.read',
  create: 'expenses.create',
  update: 'expenses.update',
  delete: 'expenses.delete',
};

const text = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const result = String(value).trim();
  return result || null;
};

const parseDate = (value) => {
  const valueText = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueText)) return null;
  const date = new Date(`${valueText}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== valueText ? null : valueText;
};

const isMissingWarehouseTable = (error) => {
  const message = [error?.message, error?.details, error?.hint].filter(Boolean).join(' ').toLowerCase();
  return String(error?.code || '') === '42P01' && message.includes('warehouse_purchases');
};

const sendDbError = (res, error) => isMissingWarehouseTable(error)
  ? res.status(501).json({ error: 'Warehouse tables are missing', hint: 'Apply db/postgres/warehouse.sql on the backend database.' })
  : res.status(500).json({ error: error.message || 'Internal server error' });

async function auth(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Authorization token is required' }); return null; }

  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); } catch (_error) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }

  const userId = payload?.sub || payload?.id;
  if (!userId) { res.status(401).json({ error: 'Invalid token payload' }); return null; }

  let user = req.employeeAccess?.user;
  if (!user) {
    const result = await db.from('users').select('id, role, branch_id').eq('id', userId).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    user = result.data;
  }
  if (!user) { res.status(401).json({ error: 'Session is no longer valid' }); return null; }

  const role = String(payload.role || user.role || '').trim().toLowerCase();
  if (!PRIVILEGED_ROLES.has(role) && role !== 'manager') {
    res.status(403).json({ error: 'Expenses are not available for this role' });
    return null;
  }

  let permissions = [];
  if (!PRIVILEGED_ROLES.has(role)) {
    const result = await db.from('user_permissions').select('permission').eq('user_id', userId);
    if (result.error && !String(result.error.message || '').toLowerCase().includes('user_permissions')) {
      throw new Error(result.error.message);
    }
    permissions = (result.data || []).map((row) => row.permission);
  }

  return {
    userId,
    role,
    branchId: payload.branchId || payload.branch_id || user.branch_id || null,
    permissions,
  };
}

const can = (access, permission) => PRIVILEGED_ROLES.has(access.role)
  || access.permissions.includes(permission)
  || (access.role === 'manager' && ['expenses.read', 'expenses.create'].includes(permission));

const requirePermission = (access, permission, res) => {
  if (can(access, permission)) return true;
  res.status(403).json({ error: `Missing permission: ${permission}` });
  return false;
};

const validate = (body, partial = false) => {
  const payload = {};
  if (body.category !== undefined || !partial) {
    payload.category = text(body.category);
    if (!payload.category) return { error: 'category is required' };
  }
  if (body.name !== undefined || !partial) {
    payload.name = text(body.name);
    if (!payload.name) return { error: 'name is required' };
  }
  if (body.amount !== undefined || !partial) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 999999999999.99) {
      return { error: 'amount must be greater than 0 and no more than 999999999999.99' };
    }
    payload.amount = Math.round(amount * 100) / 100;
  }
  if (body.spent_at !== undefined || body.date !== undefined || !partial) {
    payload.spent_at = parseDate(body.spent_at ?? body.date ?? new Date().toISOString().slice(0, 10));
    if (!payload.spent_at) return { error: 'spent_at must be a valid date in YYYY-MM-DD format' };
  }
  if (body.comment !== undefined) payload.comment = text(body.comment);
  return { payload };
};

const selectFields = `
  p.id, p.branch_id, p.supplier_name, p.purchased_at, p.total_amount,
  p.metadata, p.created_at, p.updated_at, b.name as branch_name,
  u.login as creator_login
`;

const toItem = (row) => {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    id: row.id,
    branch_id: row.branch_id,
    branch: row.branch_id ? { id: row.branch_id, name: row.branch_name || null } : null,
    category: metadata.category || null,
    name: metadata.name || row.supplier_name || null,
    amount: Number(row.total_amount || 0),
    spent_at: row.purchased_at,
    date: row.purchased_at,
    comment: metadata.comment || null,
    created_by: metadata.created_by || null,
    creator: metadata.created_by ? { id: metadata.created_by, login: row.creator_login || null } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

const byId = (id) => db.query(
  `select ${selectFields}
   from warehouse_purchases p
   left join branches b on b.id = p.branch_id
   left join users u on u.id::text = p.metadata->>'created_by'
   where p.id = $1 and p.metadata->>'type' = $2`, [id, EXPENSE_TYPE]
);

module.exports = {
  async list(req, res) {
    let access;
    try { access = await auth(req, res); } catch (error) { return sendDbError(res, error); }
    if (!access || !requirePermission(access, PERMISSIONS.read, res)) return;

    const values = [EXPENSE_TYPE];
    const where = ["p.metadata->>'type' = $1"];
    const add = (value) => { values.push(value); return `$${values.length}`; };
    if (!PRIVILEGED_ROLES.has(access.role)) where.push(`p.branch_id = ${add(access.branchId)}`);
    else if (req.query.branch_id) where.push(`p.branch_id = ${add(req.query.branch_id)}`);
    if (req.query.category) where.push(`p.metadata->>'category' = ${add(String(req.query.category).trim())}`);
    if (req.query.period && /^\d{4}-\d{2}$/.test(req.query.period)) {
      const [year, month] = req.query.period.split('-').map(Number);
      where.push(`p.purchased_at >= ${add(`${req.query.period}-01`)}`);
      where.push(`p.purchased_at < ${add(new Date(Date.UTC(year, month, 1)).toISOString())}`);
    }
    try {
      const result = await db.query(
        `select ${selectFields}
         from warehouse_purchases p
         left join branches b on b.id = p.branch_id
         left join users u on u.id::text = p.metadata->>'created_by'
         where ${where.join(' and ')} order by p.purchased_at desc, p.created_at desc`, values);
      return res.json({ items: (result.rows || []).map(toItem), count: result.rows?.length || 0 });
    } catch (error) { return sendDbError(res, error); }
  },

  async create(req, res) {
    let access;
    try { access = await auth(req, res); } catch (error) { return sendDbError(res, error); }
    if (!access || !requirePermission(access, PERMISSIONS.create, res)) return;
    if (!access.branchId) return res.status(422).json({ error: 'User branch is not assigned' });
    const draft = validate(req.body || {});
    if (draft.error) return res.status(422).json({ error: draft.error });
    const metadata = {
      type: EXPENSE_TYPE,
      category: draft.payload.category,
      name: draft.payload.name,
      comment: draft.payload.comment ?? null,
      created_by: access.userId,
    };
    try {
      const created = await db.query(
        `insert into warehouse_purchases
         (branch_id, supplier_name, purchased_at, status, total_amount, metadata)
         values ($1, $2, $3, 'received', $4, $5::jsonb) returning id`,
        [access.branchId, draft.payload.name, draft.payload.spent_at, draft.payload.amount, JSON.stringify(metadata)]);
      const result = await byId(created.rows[0].id);
      return res.status(201).json({ expense: toItem(result.rows[0]) });
    } catch (error) { return sendDbError(res, error); }
  },

  async update(req, res) {
    let access;
    try { access = await auth(req, res); } catch (error) { return sendDbError(res, error); }
    if (!access || !requirePermission(access, PERMISSIONS.update, res)) return;
    const draft = validate(req.body || {}, true);
    if (draft.error) return res.status(422).json({ error: draft.error });
    const metadata = Object.fromEntries(Object.entries(draft.payload).filter(([key]) => key !== 'amount' && key !== 'spent_at'));
    const values = [JSON.stringify(metadata), draft.payload.amount ?? null, draft.payload.spent_at ?? null, req.params.id, EXPENSE_TYPE];
    const scope = PRIVILEGED_ROLES.has(access.role) ? '' : ' and branch_id = $6';
    if (scope) values.push(access.branchId);
    try {
      const result = await db.query(
        `update warehouse_purchases
         set metadata = metadata || $1::jsonb,
             total_amount = coalesce($2, total_amount),
             purchased_at = coalesce($3::timestamptz, purchased_at),
             supplier_name = coalesce(($1::jsonb)->>'name', supplier_name),
             updated_at = now()
         where id = $4 and metadata->>'type' = $5${scope} returning id`, values);
      if (!result.rows.length) return res.status(404).json({ error: 'Expense not found' });
      const updated = await byId(result.rows[0].id);
      return res.json({ expense: toItem(updated.rows[0]) });
    } catch (error) { return sendDbError(res, error); }
  },

  async remove(req, res) {
    let access;
    try { access = await auth(req, res); } catch (error) { return sendDbError(res, error); }
    if (!access || !requirePermission(access, PERMISSIONS.delete, res)) return;
    const values = [req.params.id, EXPENSE_TYPE];
    const scope = PRIVILEGED_ROLES.has(access.role) ? '' : ' and branch_id = $3';
    if (scope) values.push(access.branchId);
    try {
      const result = await db.query(
        `delete from warehouse_purchases where id = $1 and metadata->>'type' = $2${scope} returning id`, values);
      if (!result.rows.length) return res.status(404).json({ error: 'Expense not found' });
      return res.status(204).send();
    } catch (error) { return sendDbError(res, error); }
  },
};
