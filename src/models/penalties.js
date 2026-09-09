const jwt = require('jsonwebtoken');
const { db } = require('../config/postgres');

const PRIVILEGED_ROLES = new Set(['admin_network', 'admin_branch', 'admin', 'super-manager']);
const PENALTY_TYPE = 'penalty';
const PERMISSIONS = { read: 'penalties.read', create: 'penalties.create' };

const text = (value) => {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result || null;
};

const parseDate = (value) => {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? null : date;
};

const isMissingWarehouseTable = (error) => (
  String(error?.code || '') === '42P01'
  && String(error?.message || '').toLowerCase().includes('warehouse_purchases')
);

const sendDbError = (res, error) => isMissingWarehouseTable(error)
  ? res.status(501).json({ error: 'Warehouse tables are missing', hint: 'The penalties use the existing warehouse_purchases table.' })
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
    res.status(403).json({ error: 'Penalties are not available for this role' });
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
  || (access.role === 'manager' && ['penalties.read', 'penalties.create'].includes(permission));
const requirePermission = (access, permission, res) => {
  if (can(access, permission)) return true;
  res.status(403).json({ error: `Missing permission: ${permission}` });
  return false;
};

const selectFields = `
  p.id, p.branch_id, p.purchased_at, p.total_amount, p.metadata, p.created_at,
  b.name as branch_name, recipient.id as recipient_id, recipient.name as recipient_name,
  u.login as creator_login, creator_barber.name as creator_name
`;

const toItem = (row) => {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    id: row.id,
    branch_id: row.branch_id,
    branch: row.branch_id ? { id: row.branch_id, name: row.branch_name || null } : null,
    recipient: { id: row.recipient_id || metadata.recipient_id || null, name: row.recipient_name || metadata.recipient_name || 'Сотрудник' },
    amount: Number(row.total_amount || 0),
    penalty_at: row.purchased_at,
    date: row.purchased_at,
    comment: metadata.comment || null,
    creator: metadata.created_by ? { id: metadata.created_by, name: row.creator_name || null, login: row.creator_login || null } : null,
    created_at: row.created_at,
  };
};

const queryById = (id) => db.query(
  `select ${selectFields}
   from warehouse_purchases p
   left join branches b on b.id = p.branch_id
   left join barbers recipient on recipient.id::text = p.metadata->>'recipient_id'
   left join users u on u.id::text = p.metadata->>'created_by'
   left join barbers creator_barber on creator_barber.id::text = p.metadata->>'created_by'
   where p.id = $1 and p.metadata->>'type' = $2`, [id, PENALTY_TYPE]
);

module.exports = {
  async list(req, res) {
    let access;
    try { access = await auth(req, res); } catch (error) { return sendDbError(res, error); }
    if (!access || !requirePermission(access, PERMISSIONS.read, res)) return;

    const values = [PENALTY_TYPE];
    const where = ["p.metadata->>'type' = $1"];
    const add = (value) => { values.push(value); return `$${values.length}`; };
    if (!PRIVILEGED_ROLES.has(access.role)) where.push(`p.branch_id = ${add(access.branchId)}`);
    else if (req.query.branch_id) where.push(`p.branch_id = ${add(req.query.branch_id)}`);
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
         left join barbers recipient on recipient.id::text = p.metadata->>'recipient_id'
         left join users u on u.id::text = p.metadata->>'created_by'
         left join barbers creator_barber on creator_barber.id::text = p.metadata->>'created_by'
         where ${where.join(' and ')} order by p.purchased_at desc, p.created_at desc`, values);
      return res.json({ items: (result.rows || []).map(toItem), count: result.rows?.length || 0 });
    } catch (error) { return sendDbError(res, error); }
  },

  async create(req, res) {
    let access;
    try { access = await auth(req, res); } catch (error) { return sendDbError(res, error); }
    if (!access || !requirePermission(access, PERMISSIONS.create, res)) return;
    const branchId = PRIVILEGED_ROLES.has(access.role)
      ? (text(req.body?.branch_id || req.body?.branchId) || access.branchId)
      : access.branchId;
    if (!branchId) return res.status(422).json({ error: 'Branch is required' });

    const recipientId = text(req.body?.recipient_id || req.body?.recipientId);
    const comment = text(req.body?.comment);
    const penaltyAt = parseDate(req.body?.penalty_at || req.body?.date || new Date().toISOString().slice(0, 10));
    const amount = Number(req.body?.amount);
    if (!recipientId) return res.status(422).json({ error: 'recipient_id is required' });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 999999999999.99) {
      return res.status(422).json({ error: 'amount must be greater than 0 and no more than 999999999999.99' });
    }
    if (!penaltyAt) return res.status(422).json({ error: 'penalty_at must be a valid date in YYYY-MM-DD format' });

    try {
      const recipient = await db.query(
        'select id, name, branch_id from barbers where id = $1 and branch_id = $2 and coalesce(is_archived, false) = false',
        [recipientId, branchId]
      );
      if (!recipient.rows.length) return res.status(422).json({ error: 'Recipient is not an active employee of the selected branch' });

      const metadata = {
        type: PENALTY_TYPE,
        recipient_id: recipientId,
        recipient_name: recipient.rows[0].name || null,
        comment,
        created_by: access.userId,
      };
      const created = await db.query(
        `insert into warehouse_purchases
         (branch_id, supplier_name, purchased_at, status, total_amount, metadata)
         values ($1, 'Штраф', $2, 'received', $3, $4::jsonb) returning id`,
        [branchId, penaltyAt, Math.round(amount * 100) / 100, JSON.stringify(metadata)]
      );
      const result = await queryById(created.rows[0].id);
      return res.status(201).json({ penalty: toItem(result.rows[0]) });
    } catch (error) { return sendDbError(res, error); }
  },
};
