const jwt = require('jsonwebtoken');
const { db } = require('../config/postgres');

const PRIVILEGED_ROLES = new Set(['admin_network', 'admin_branch', 'admin', 'super-manager']);
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

const isMissingTable = (error) => String(error?.code || '') === '42P01';
const sendDbError = (res, error) => isMissingTable(error)
  ? res.status(501).json({ error: 'Expenses table is missing', hint: 'Apply db/postgres/expenses.sql on the backend database.' })
  : res.status(500).json({ error: error.message || 'Internal server error' });

async function auth(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authorization token is required' });

  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); } catch (_error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const userId = payload?.sub || payload?.id;
  if (!userId) return res.status(401).json({ error: 'Invalid token payload' });
  let user = req.employeeAccess?.user;
  if (!user) {
    const result = await db.from('users').select('id, role, branch_id').eq('id', userId).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    user = result.data;
  }
  if (!user) return res.status(401).json({ error: 'Session is no longer valid' });

  const role = String(payload.role || user.role || '').trim().toLowerCase();
  if (!PRIVILEGED_ROLES.has(role) && role !== 'manager') {
    return res.status(403).json({ error: 'Expenses are not available for this role' });
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
    if (!Number.isFinite(amount) || amount <= 0) return { error: 'amount must be greater than 0' };
    payload.amount = Math.round(amount * 100) / 100;
  }
  if (body.spent_at !== undefined || body.date !== undefined || !partial) {
    payload.spent_at = parseDate(body.spent_at ?? body.date ?? new Date().toISOString().slice(0, 10));
    if (!payload.spent_at) return { error: 'spent_at must be a valid date in YYYY-MM-DD format' };
  }
  if (body.comment !== undefined) payload.comment = text(body.comment);
  return { payload };
};

const toItem = (row) => ({
  id: row.id,
  branch_id: row.branch_id,
  branch: row.branch_id ? { id: row.branch_id, name: row.branch_name || null } : null,
  category: row.category,
  name: row.name,
  amount: Number(row.amount),
  spent_at: row.spent_at,
  date: row.spent_at,
  comment: row.comment || null,
  created_by: row.created_by,
  creator: row.creator_login ? { id: row.created_by, login: row.creator_login } : null,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const byId = (id) => db.query(
  `select e.*, b.name as branch_name, u.login as creator_login
   from expenses e left join branches b on b.id = e.branch_id left join users u on u.id = e.created_by
   where e.id = $1`, [id]
);

module.exports = {
  async list(req, res) {
    let access;
    try { access = await auth(req, res); } catch (error) { return sendDbError(res, error); }
    if (!access || !requirePermission(access, PERMISSIONS.read, res)) return;

    const values = [];
    const where = [];
    const add = (value) => { values.push(value); return `$${values.length}`; };
    if (!PRIVILEGED_ROLES.has(access.role)) where.push(`e.branch_id = ${add(access.branchId)}`);
    else if (req.query.branch_id) where.push(`e.branch_id = ${add(req.query.branch_id)}`);
    if (req.query.category) where.push(`e.category = ${add(String(req.query.category).trim())}`);
    if (req.query.period && /^\d{4}-\d{2}$/.test(req.query.period)) {
      where.push(`e.spent_at >= ${add(`${req.query.period}-01`)}`);
      const [year, month] = req.query.period.split('-').map(Number);
      where.push(`e.spent_at < ${add(new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10))}`);
    }
    if (req.query.from) { const date = parseDate(req.query.from); if (!date) return res.status(422).json({ error: 'from must be a valid date' }); where.push(`e.spent_at >= ${add(date)}`); }
    if (req.query.to) { const date = parseDate(req.query.to); if (!date) return res.status(422).json({ error: 'to must be a valid date' }); where.push(`e.spent_at <= ${add(date)}`); }
    try {
      const result = await db.query(
        `select e.*, b.name as branch_name, u.login as creator_login
         from expenses e left join branches b on b.id = e.branch_id left join users u on u.id = e.created_by
         ${where.length ? `where ${where.join(' and ')}` : ''} order by e.spent_at desc, e.created_at desc`, values);
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
    try {
      const created = await db.query(
        `insert into expenses (branch_id, category, name, amount, spent_at, comment, created_by)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [access.branchId, draft.payload.category, draft.payload.name, draft.payload.amount, draft.payload.spent_at, draft.payload.comment ?? null, access.userId]);
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
    const keys = Object.keys(draft.payload);
    if (!keys.length) return res.status(422).json({ error: 'No fields to update' });
    const values = [];
    const add = (value) => { values.push(value); return `$${values.length}`; };
    const assignments = keys.map((key) => `${key} = ${add(draft.payload[key])}`);
    const idPlaceholder = add(req.params.id);
    let scope = '';
    if (!PRIVILEGED_ROLES.has(access.role)) scope = ` and branch_id = ${add(access.branchId)}`;
    try {
      const result = await db.query(`update expenses set ${assignments.join(', ')}, updated_at = now() where id = ${idPlaceholder}${scope} returning id`, values);
      if (!result.rows.length) return res.status(404).json({ error: 'Expense not found' });
      const updated = await byId(result.rows[0].id);
      return res.json({ expense: toItem(updated.rows[0]) });
    } catch (error) { return sendDbError(res, error); }
  },

  async remove(req, res) {
    let access;
    try { access = await auth(req, res); } catch (error) { return sendDbError(res, error); }
    if (!access || !requirePermission(access, PERMISSIONS.delete, res)) return;
    const values = [req.params.id];
    const scope = PRIVILEGED_ROLES.has(access.role) ? '' : ' and branch_id = $2';
    if (scope) values.push(access.branchId);
    try {
      const result = await db.query(`delete from expenses where id = $1${scope} returning id`, values);
      if (!result.rows.length) return res.status(404).json({ error: 'Expense not found' });
      return res.status(204).send();
    } catch (error) { return sendDbError(res, error); }
  },
};
