const jwt = require('jsonwebtoken');
const { db } = require('../config/postgres');

const PRIVILEGED_ROLES = new Set(['admin_network', 'admin_branch', 'admin', 'super-manager']);
const PENALTY_TYPE = 'penalty';
const PERMISSIONS = { read: 'penalties.read', create: 'penalties.create', cancel: 'penalties.cancel' };

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
const isMissingVerifixTable = (error) => (
  String(error?.code || '') === '42P01'
  && String(error?.message || '').toLowerCase().includes('barber_activity_events')
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
  || (access.role === 'manager' && ['penalties.read', 'penalties.create', 'penalties.cancel'].includes(permission));
const requirePermission = (access, permission, res) => {
  if (can(access, permission)) return true;
  res.status(403).json({ error: `Missing permission: ${permission}` });
  return false;
};

const selectFields = `
  p.id, p.branch_id, p.purchased_at, p.total_amount, p.status, p.metadata, p.created_at,
  b.name as branch_name, recipient.id as recipient_id, recipient.name as recipient_name,
  u.login as creator_login, creator_barber.name as creator_name
`;

const verifixSelectFields = `
  e.id, e.branch_id, e.occurred_at, e.penalty_amount, e.penalty_reason,
  e.late_by_minutes, e.grace_minutes, e.scheduled_start_at, e.is_late,
  e.created_at, e.metadata, b.name as branch_name,
  barber.id as recipient_id, barber.name as recipient_name
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
    comment: metadata.comment || row.penalty_reason || (row.penalty_source === 'late_minutes' && row.late_by_minutes
      ? `Опоздание на ${row.late_by_minutes} мин.`
      : null),
    creator: metadata.created_by ? { id: metadata.created_by, name: row.creator_name || null, login: row.creator_login || null } : null,
    created_at: row.created_at,
    canceled: row.status === 'cancelled' || metadata.canceled === true,
    canceled_at: metadata.canceled_at || null,
    canceled_by: metadata.canceled_by || null,
    source: row.penalty_source || 'manual',
    late_minutes: row.late_by_minutes ? Number(row.late_by_minutes) : null,
    scheduled_start_at: row.scheduled_start_at || null,
    occurred_at: row.occurred_at || null,
    grace_minutes: row.grace_minutes == null ? null : Number(row.grace_minutes),
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
    const source = text(req.query.source);
    const status = text(req.query.status);
    const recipientId = text(req.query.recipient_id || req.query.recipientId);
    if (source === 'late_minutes') where.push('false');
    if (source === 'manual') { /* manual penalties are already selected by type */ }
    if (status === 'cancelled') where.push(`p.status = 'cancelled'`);
    if (status === 'active') where.push(`coalesce(p.status, '') <> 'cancelled'`);
    if (recipientId) where.push(`p.metadata->>'recipient_id' = ${add(recipientId)}`);
    try {
      const result = await db.query(
        `select ${selectFields}
         from warehouse_purchases p
         left join branches b on b.id = p.branch_id
         left join barbers recipient on recipient.id::text = p.metadata->>'recipient_id'
         left join users u on u.id::text = p.metadata->>'created_by'
         left join barbers creator_barber on creator_barber.id::text = p.metadata->>'created_by'
         where ${where.join(' and ')} order by p.purchased_at desc, p.created_at desc`, values);
      const manualItems = (result.rows || []).map(toItem);
      let lateItems = [];
      let penaltyPerMinute = 0;
      try {
        const settings = await db.query('select penalty_per_minute from verifix_settings where id = 1');
        penaltyPerMinute = Number(settings.rows[0]?.penalty_per_minute || 0);
      } catch (error) {
        if (!String(error?.code || '').includes('42P01')) throw error;
      }
      const lateValues = [];
      const lateWhere = ['(e.is_late = true OR e.penalty_amount > 0)'];
      const lateAdd = (value) => { lateValues.push(value); return `$${lateValues.length}`; };
      if (source === 'manual') lateWhere.push('false');
      if (status === 'cancelled') lateWhere.push(`e.metadata->>'canceled' = 'true'`);
      if (status === 'active') lateWhere.push(`coalesce(e.metadata->>'canceled', 'false') <> 'true'`);
      if (recipientId) lateWhere.push(`e.barber_id = ${lateAdd(recipientId)}`);
      if (!PRIVILEGED_ROLES.has(access.role)) lateWhere.push(`e.branch_id = ${lateAdd(access.branchId)}`);
      else if (req.query.branch_id) lateWhere.push(`e.branch_id = ${lateAdd(req.query.branch_id)}`);
      if (req.query.period && /^\d{4}-\d{2}$/.test(req.query.period)) {
        const [year, month] = req.query.period.split('-').map(Number);
        lateWhere.push(`e.occurred_at >= ${lateAdd(`${req.query.period}-01T00:00:00.000Z`)}`);
        lateWhere.push(`e.occurred_at < ${lateAdd(new Date(Date.UTC(year, month, 1)).toISOString() )}`);
      }
      try {
        const lateResult = await db.query(
          `select ${verifixSelectFields}
           from barber_activity_events e
           left join branches b on b.id = e.branch_id
           left join barbers barber on barber.id = e.barber_id
           where ${lateWhere.join(' and ')}
           order by e.occurred_at desc`, lateValues);
        lateItems = (lateResult.rows || []).map((row) => toItem({
          ...row,
          metadata: row.metadata || {},
          penalty_source: 'late_minutes',
          purchased_at: row.occurred_at,
          total_amount: Number(row.penalty_amount || 0) > 0
            ? row.penalty_amount
            : Math.round(Number(row.late_by_minutes || 0) * Math.max(0, penaltyPerMinute) * 100) / 100,
          recipient_id: row.recipient_id,
          recipient_name: row.recipient_name,
          late_by_minutes: row.late_by_minutes,
          grace_minutes: row.grace_minutes,
          scheduled_start_at: row.scheduled_start_at,
          occurred_at: row.occurred_at,
          penalty_reason: row.penalty_reason,
          status: 'received',
        }));
      } catch (error) {
        if (!isMissingVerifixTable(error)) throw error;
      }
      const items = [...manualItems, ...lateItems].sort((left, right) => (
        new Date(right.date || 0).getTime() - new Date(left.date || 0).getTime()
      ));
      return res.json({ items, count: items.length });
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

  async cancel(req, res) {
    let access;
    try { access = await auth(req, res); } catch (error) { return sendDbError(res, error); }
    if (!access || !requirePermission(access, PERMISSIONS.cancel, res)) return;
    try {
      const existing = await db.query(
        `select id, branch_id, status, metadata
         from warehouse_purchases
         where id = $1 and metadata->>'type' = $2`, [req.params.id, PENALTY_TYPE]
      );
      if (!existing.rows.length) {
        let lateResult;
        try {
          lateResult = await db.query(
            `select ${verifixSelectFields}
             from barber_activity_events e
             left join branches b on b.id = e.branch_id
             left join barbers barber on barber.id = e.barber_id
             where e.id = $1 and (e.is_late = true or e.penalty_amount > 0)`, [req.params.id]
          );
        } catch (error) {
          if (isMissingVerifixTable(error)) return res.status(404).json({ error: 'Penalty not found' });
          throw error;
        }
        if (!lateResult.rows.length) return res.status(404).json({ error: 'Penalty not found' });
        const lateRow = lateResult.rows[0];
        if (!PRIVILEGED_ROLES.has(access.role) && lateRow.branch_id !== access.branchId) {
          return res.status(404).json({ error: 'Penalty not found' });
        }
        if (lateRow.metadata?.canceled === true) {
          return res.status(409).json({ error: 'Penalty is already cancelled' });
        }
        await db.query(
          `update barber_activity_events
           set metadata = coalesce(metadata, '{}'::jsonb) || $1::jsonb
           where id = $2`,
          [JSON.stringify({ canceled: true, canceled_at: new Date().toISOString(), canceled_by: access.userId }), req.params.id]
        );
        const canceled = { ...lateRow, metadata: { ...(lateRow.metadata || {}), canceled: true }, penalty_source: 'late_minutes', total_amount: lateRow.penalty_amount, purchased_at: lateRow.occurred_at, status: 'cancelled' };
        return res.json({ penalty: toItem(canceled) });
      }
      const row = existing.rows[0];
      if (!PRIVILEGED_ROLES.has(access.role) && row.branch_id !== access.branchId) {
        return res.status(404).json({ error: 'Penalty not found' });
      }
      if (row.status === 'cancelled' || row.metadata?.canceled === true) {
        return res.status(409).json({ error: 'Penalty is already cancelled' });
      }
      await db.query(
        `update warehouse_purchases
         set status = 'cancelled', metadata = metadata || $1::jsonb, updated_at = now()
         where id = $2 and metadata->>'type' = $3`,
        [JSON.stringify({ canceled: true, canceled_at: new Date().toISOString(), canceled_by: access.userId }), req.params.id, PENALTY_TYPE]
      );
      const result = await queryById(req.params.id);
      return res.json({ penalty: toItem(result.rows[0]) });
    } catch (error) { return sendDbError(res, error); }
  },
};
