const bcrypto = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, pool } = require('../config/postgres');
const { toAbsolutePublicUrl } = require('../config/uploads');

const ACTIVE_ORDER_STATUSES = ['waiting', 'called', 'swapped', 'in_progress'];
const HISTORY_STATUSES = ['completed', 'cancelled', 'no_show', 'not_in_time'];
const MERCHANT_ALLOWED_ROLES = new Set(['admin_network', 'admin_branch', 'admin', 'manager', 'merchant', 'super-manager']);

const normalizeText = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text || null;
};

const normalizeImageUrl = (req, value) => {
  const normalized = normalizeText(value);
  return normalized ? toAbsolutePublicUrl(normalized, req) : normalized;
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

const parseMoney = (value, fallback = null) => {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const getBearerToken = (req) => {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
};

const isMissingColumnError = (error, column) => {
  const message = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return String(error?.code || '') === '42703'
    || (message.includes(column.toLowerCase()) && (
      message.includes('does not exist')
      || message.includes('could not find')
      || message.includes('schema cache')
    ));
};

const isMissingRelationError = (error, relation) => {
  const message = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return ['42p01', '42P01'].includes(String(error?.code || ''))
    || (message.includes(relation.toLowerCase()) && (
      message.includes('does not exist')
      || message.includes('could not find')
      || message.includes('schema cache')
    ));
};

const resolveBarbershopIdFromBranch = async (branchId) => {
  const normalizedBranchId = normalizeId(branchId);
  if (!normalizedBranchId) return null;

  try {
    const result = await db.query(
      `select marketplace_barbershop_id
       from branches
       where id = $1
       limit 1`,
      [normalizedBranchId]
    );

    return normalizeId(result.rows[0]?.marketplace_barbershop_id);
  } catch (error) {
    if (isMissingColumnError(error, 'marketplace_barbershop_id')) return null;
    throw error;
  }
};

const resolveSingleBarbershopId = async () => {
  try {
    const result = await db.query(
      `select id
       from marketplace_barbershops
       where not (coalesce(metadata, '{}'::jsonb) ? 'legacy_branch_id')
         and coalesce(metadata ->> 'fallback', 'false') <> 'true'
       order by sort_order asc, name asc, id asc
       limit 2`
    );

    return result.rows.length === 1 ? normalizeId(result.rows[0]?.id) : null;
  } catch (error) {
    if (isMissingRelationError(error, 'marketplace_barbershops')) return null;
    throw error;
  }
};

const persistUserBarbershopId = async (userId, barbershopId) => {
  const normalizedUserId = normalizeId(userId);
  const normalizedBarbershopId = normalizeId(barbershopId);
  if (!normalizedUserId || !normalizedBarbershopId) return;

  try {
    await db.query(
      `update users
       set marketplace_barbershop_id = $1
       where id = $2
         and marketplace_barbershop_id is null`,
      [normalizedBarbershopId, normalizedUserId]
    );
  } catch (error) {
    if (!isMissingColumnError(error, 'marketplace_barbershop_id')) throw error;
  }
};

const resolveMerchantBarbershopId = async (user) => {
  const assignedBarbershopId = normalizeId(user?.marketplace_barbershop_id);
  if (assignedBarbershopId) return assignedBarbershopId;

  const branchBarbershopId = await resolveBarbershopIdFromBranch(user?.branch_id);
  const resolvedBarbershopId = branchBarbershopId || await resolveSingleBarbershopId();
  if (!resolvedBarbershopId) return null;

  await persistUserBarbershopId(user.id, resolvedBarbershopId);
  user.marketplace_barbershop_id = resolvedBarbershopId;
  return resolvedBarbershopId;
};

const requireMerchantAccess = async (req, res) => {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (_err) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }

  const userId = payload.sub || payload.id;
  if (!userId) {
    res.status(401).json({ error: 'Invalid token payload' });
    return null;
  }

  let user;
  try {
    const result = await db.query(
      `select id, login, role, branch_id, marketplace_barbershop_id
       from users
       where id = $1
       limit 1`,
      [userId]
    );
    user = result.rows[0] || null;
  } catch (error) {
    if (!isMissingColumnError(error, 'marketplace_barbershop_id')) {
      res.status(500).json({ error: error.message });
      return null;
    }

    const result = await db.query(
      `select id, login, role, branch_id
       from users
       where id = $1
       limit 1`,
      [userId]
    );
    user = result.rows[0] ? { ...result.rows[0], marketplace_barbershop_id: null } : null;
  }

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }

  if (!MERCHANT_ALLOWED_ROLES.has(user.role)) {
    res.status(403).json({ error: 'Merchant access is required' });
    return null;
  }

  let barbershopId;
  try {
    barbershopId = await resolveMerchantBarbershopId(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
    return null;
  }

  if (!barbershopId) {
    res.status(403).json({ error: 'marketplace_barbershop_id is not assigned for this user' });
    return null;
  }

  return { barbershopId, user };
};

const branchItem = (row) => ({
  address: row?.address || null,
  city: row?.city || null,
  id: row?.id,
  is_active: row?.is_active ?? null,
  marketplace_barbershop_id: row?.marketplace_barbershop_id || null,
  name: row?.name || null,
  timezone: row?.timezone || null,
  work_hours: row?.work_hours || null,
});

const barberItem = (row) => ({
  branch_id: row?.branch_id || null,
  created_at: row?.created_at || null,
  id: row?.id,
  is_active: row?.is_active ?? null,
  name: row?.name || null,
  phone: row?.phone || null,
  photo_url: row?.photo_url || null,
  specialization: row?.specialization || null,
  updated_at: row?.updated_at || null,
});

const serviceItem = (row, req = null) => ({
  category_name: row?.category || null,
  created_at: row?.created_at || null,
  duration_minutes: row?.duration_minutes ?? null,
  id: row?.id,
  image: row?.image ? toAbsolutePublicUrl(row.image, req) : null,
  is_active: row?.is_active ?? null,
  name: row?.name || null,
  price: row?.base_price ?? null,
  updated_at: row?.updated_at || null,
});

const categoryItem = (row) => ({
  created_at: row?.created_at || null,
  id: row?.id,
  is_active: row?.is_active ?? null,
  name: row?.name || null,
  sort_order: row?.sort_order ?? null,
  title: row?.name || null,
  updated_at: row?.updated_at || null,
});

const orderItem = (row) => ({
  amount: row?.amount ?? 0,
  branch_id: row?.branch_id || null,
  branches: row?.branch_name ? { name: row.branch_name } : null,
  called_at: row?.called_at || null,
  completed_at: row?.completed_at || null,
  created_at: row?.created_at || null,
  customer_name: row?.customer_name || null,
  id: row?.id,
  payment_method: row?.payment_method || null,
  phone_number: row?.phone_number || null,
  status: row?.status || null,
  updated_at: row?.updated_at || null,
});

const branchPayload = (body = {}, { partial = false, barbershopId }) => {
  const payload = {};

  if (body.name !== undefined) {
    const name = normalizeText(body.name);
    if (!name) return { error: 'name is required' };
    payload.name = name;
  } else if (!partial) {
    return { error: 'name is required' };
  }

  for (const key of ['address', 'city', 'timezone']) {
    if (body[key] !== undefined) payload[key] = normalizeText(body[key]);
  }

  if (body.work_hours !== undefined) {
    if (body.work_hours === null || typeof body.work_hours === 'object') {
      payload.work_hours = body.work_hours;
    } else {
      try {
        payload.work_hours = JSON.parse(String(body.work_hours));
      } catch (_err) {
        return { error: 'work_hours must be an object or valid JSON string' };
      }
    }
  }

  if (body.is_active !== undefined) {
    const isActive = parseBoolean(body.is_active, null);
    if (isActive === null) return { error: 'is_active must be a boolean' };
    payload.is_active = isActive;
  } else if (!partial) {
    payload.is_active = true;
  }

  if (!partial) payload.marketplace_barbershop_id = barbershopId;

  return { payload };
};

const categoryPayload = (body = {}, { partial = false, barbershopId }) => {
  const payload = {};

  if (body.name !== undefined || body.title !== undefined) {
    const name = normalizeText(body.name ?? body.title);
    if (!name) return { error: 'name is required' };
    payload.name = name;
  } else if (!partial) {
    return { error: 'name is required' };
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

  if (!partial) payload.marketplace_barbershop_id = barbershopId;

  return { payload };
};

const servicePayload = (body = {}, { partial = false, barbershopId }) => {
  const payload = {};

  if (body.name !== undefined) {
    const name = normalizeText(body.name);
    if (!name) return { error: 'name is required' };
    payload.name = name;
  } else if (!partial) {
    return { error: 'name is required' };
  }

  if (body.duration_minutes !== undefined || body.duration !== undefined) {
    const duration = parseInteger(body.duration_minutes ?? body.duration, null);
    if (!duration || duration <= 0) return { error: 'duration_minutes must be a positive integer' };
    payload.duration_minutes = duration;
  } else if (!partial) {
    return { error: 'duration_minutes is required' };
  }

  if (body.price !== undefined || body.base_price !== undefined) {
    const price = parseMoney(body.base_price ?? body.price, null);
    if (price === null && body.base_price !== null && body.price !== null) {
      return { error: 'price must be a non-negative number' };
    }
    payload.base_price = price;
  }

  if (body.category_name !== undefined || body.category !== undefined) {
    payload.category = normalizeText(body.category_name ?? body.category);
  }

  if (body.image !== undefined) payload.image = normalizeText(body.image);

  if (body.is_active !== undefined) {
    const isActive = parseBoolean(body.is_active, null);
    if (isActive === null) return { error: 'is_active must be a boolean' };
    payload.is_active = isActive;
  } else if (!partial) {
    payload.is_active = true;
  }

  if (!partial) payload.marketplace_barbershop_id = barbershopId;

  return { payload };
};

const barberPayload = async (body = {}, { partial = false, barbershopId }) => {
  const payload = {};

  if (body.name !== undefined) {
    const name = normalizeText(body.name);
    if (!name) return { error: 'name is required' };
    payload.name = name;
  } else if (!partial) {
    return { error: 'name is required' };
  }

  if (body.branch_id !== undefined || !partial) {
    const branchId = normalizeId(body.branch_id);
    const resolved = branchId || await firstMerchantBranchId(barbershopId);
    if (!resolved) return { error: 'branch_id is required' };
    const belongs = await branchBelongsToBarbershop(resolved, barbershopId);
    if (!belongs) return { error: 'branch_id does not belong to this barbershop' };
    payload.branch_id = resolved;
  }

  for (const key of ['phone', 'photo_url', 'specialization']) {
    if (body[key] !== undefined) payload[key] = normalizeText(body[key]);
  }

  if (body.is_active !== undefined) {
    const isActive = parseBoolean(body.is_active, null);
    if (isActive === null) return { error: 'is_active must be a boolean' };
    payload.is_active = isActive;
  } else if (!partial) {
    payload.is_active = true;
  }

  if (!partial) {
    payload.is_authorized = true;
    payload.is_on_shift = false;
  }

  return { payload };
};

async function branchBelongsToBarbershop(branchId, barbershopId) {
  const result = await db.query(
    `select id
     from branches
     where id = $1 and marketplace_barbershop_id = $2
     limit 1`,
    [branchId, barbershopId]
  );

  return Boolean(result.rows[0]);
}

async function firstMerchantBranchId(barbershopId) {
  const result = await db.query(
    `select id
     from branches
     where marketplace_barbershop_id = $1
     order by name asc
     limit 1`,
    [barbershopId]
  );

  return result.rows[0]?.id || null;
}

async function listOrders({ barbershopId, statuses, limit = 50, from = null, to = null }) {
  const params = [barbershopId, statuses, limit];
  let dateFilter = '';

  if (from) {
    params.push(from);
    dateFilter += ` and q.created_at >= $${params.length}`;
  }

  if (to) {
    params.push(to);
    dateFilter += ` and q.created_at <= $${params.length}`;
  }

  const result = await db.query(
    `select
        q.id,
        q.branch_id,
        q.status,
        q.payment_method,
        q.created_at,
        q.started_at as called_at,
        q.finished_at as completed_at,
        q.updated_at,
        c.name as customer_name,
        c.phone as phone_number,
        br.name as branch_name,
        coalesce(q.price_override, sum(coalesce(s.base_price, 0)), 0) as amount
     from queue_entries q
     join branches br on br.id = q.branch_id and br.marketplace_barbershop_id = $1
     left join clients c on c.id = q.client_id
     left join lateral unnest(
       coalesce(
         q.service_ids,
         case when q.service_id is null then array[]::uuid[] else array[q.service_id] end
       )
     ) as sid(service_id) on true
     left join services s on s.id = sid.service_id
     where q.status = any($2)
       ${dateFilter}
     group by q.id, c.id, br.name
     order by q.created_at desc
     limit $3`,
    params
  );

  return result.rows.map(orderItem);
}

class Merchant {
  async me(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    return res.json({
      barbershop_id: access.barbershopId,
      user: access.user,
    });
  }

  async dashboard(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    try {
      const [branches, barbers, services, activeOrders, today] = await Promise.all([
        db.query('select count(*)::int as count from branches where marketplace_barbershop_id = $1', [access.barbershopId]),
        db.query(
          `select count(*)::int as count
           from barbers b
           join branches br on br.id = b.branch_id
           where br.marketplace_barbershop_id = $1`,
          [access.barbershopId]
        ),
        db.query('select count(*)::int as count from services where marketplace_barbershop_id = $1', [access.barbershopId]),
        listOrders({ barbershopId: access.barbershopId, statuses: ACTIVE_ORDER_STATUSES, limit: 10 }),
        db.query(
          `select
              count(distinct q.id)::int as completed,
              coalesce(sum(coalesce(q.price_override, service_totals.amount, 0)), 0) as revenue
           from queue_entries q
           join branches br on br.id = q.branch_id and br.marketplace_barbershop_id = $1
           left join lateral (
             select sum(coalesce(s.base_price, 0)) as amount
             from unnest(
               coalesce(
                 q.service_ids,
                 case when q.service_id is null then array[]::uuid[] else array[q.service_id] end
               )
             ) as sid(service_id)
             left join services s on s.id = sid.service_id
           ) service_totals on true
           where q.status = 'completed'
             and q.finished_at >= date_trunc('day', now())
             and q.finished_at < date_trunc('day', now()) + interval '1 day'`,
          [access.barbershopId]
        ),
      ]);

      return res.json({
        active_orders: {
          items: activeOrders,
          total: activeOrders.length,
        },
        barbershop_id: access.barbershopId,
        counts: {
          active_orders: activeOrders.length,
          barbers: barbers.rows[0]?.count || 0,
          branches: branches.rows[0]?.count || 0,
          services: services.rows[0]?.count || 0,
        },
        today: {
          completed: today.rows[0]?.completed || 0,
          revenue: Number(today.rows[0]?.revenue || 0),
        },
        warnings: [],
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async activeOrders(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    try {
      const limit = Math.min(Math.max(parseInteger(req.query?.limit, 20) || 20, 1), 100);
      const items = await listOrders({ barbershopId: access.barbershopId, statuses: ACTIVE_ORDER_STATUSES, limit });
      return res.json({ items, total: items.length });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async history(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    try {
      const limit = Math.min(Math.max(parseInteger(req.query?.limit, 50) || 50, 1), 200);
      const from = normalizeText(req.query?.from || req.query?.start_date);
      const to = normalizeText(req.query?.to || req.query?.end_date);
      const items = await listOrders({
        barbershopId: access.barbershopId,
        from,
        limit,
        statuses: HISTORY_STATUSES,
        to,
      });
      return res.json({ items, total: items.length });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async listBranches(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    try {
      const result = await db.query(
        `select id, name, address, city, work_hours, timezone, is_active, marketplace_barbershop_id
         from branches
         where marketplace_barbershop_id = $1
         order by name asc`,
        [access.barbershopId]
      );
      const items = result.rows.map(branchItem);
      return res.json({ items, total: items.length });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async createBranch(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    const { payload, error: payloadError } = branchPayload(req.body || {}, {
      barbershopId: access.barbershopId,
    });
    if (payloadError) return res.status(400).json({ error: payloadError });

    try {
      const result = await db.query(
        `insert into branches (name, address, city, work_hours, timezone, is_active, marketplace_barbershop_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, name, address, city, work_hours, timezone, is_active, marketplace_barbershop_id`,
        [
          payload.name,
          payload.address || null,
          payload.city || null,
          payload.work_hours || null,
          payload.timezone || null,
          payload.is_active,
          access.barbershopId,
        ]
      );
      return res.status(201).json({ item: branchItem(result.rows[0]) });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async updateBranch(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Branch id is required' });

    const { payload, error: payloadError } = branchPayload(req.body || {}, {
      barbershopId: access.barbershopId,
      partial: true,
    });
    if (payloadError) return res.status(400).json({ error: payloadError });
    if (!Object.keys(payload).length) return res.status(400).json({ error: 'No fields to update' });

    try {
      const keys = Object.keys(payload);
      const values = keys.map((key) => payload[key]);
      const setSql = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
      const result = await db.query(
        `update branches
         set ${setSql}
         where id = $${keys.length + 1} and marketplace_barbershop_id = $${keys.length + 2}
         returning id, name, address, city, work_hours, timezone, is_active, marketplace_barbershop_id`,
        [...values, id, access.barbershopId]
      );

      if (!result.rows[0]) return res.status(404).json({ error: 'Branch not found' });
      return res.json({ item: branchItem(result.rows[0]) });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async deleteBranch(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Branch id is required' });

    // hard = true  -> full purge: barbers of the branch (+ their logins), visits and payments
    // hard = false -> keep statistics: detach visits/staff/barbers, remove only the branch
    const purge = parseBoolean(req.query?.hard ?? req.body?.hard, false) === true;

    const client = await pool.connect();
    const tableExists = async (name) => {
      const r = await client.query('select to_regclass($1) as reg', [name]);
      return Boolean(r.rows[0]?.reg);
    };

    try {
      await client.query('BEGIN');

      // Ownership: branch must belong to this merchant's barbershop
      const owned = await client.query(
        `select id from branches where id = $1 and marketplace_barbershop_id = $2`,
        [id, access.barbershopId]
      );
      if (!owned.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Branch not found' });
      }

      const hasQueue = await tableExists('queue_entries');
      const hasMedia = await tableExists('media_assets');

      if (purge) {
        if (hasQueue && (await tableExists('payments'))) {
          await client.query(
            `delete from payments where queue_entry_id in (select id from queue_entries where branch_id = $1)`,
            [id]
          );
        }
        if (hasQueue) {
          await client.query(`delete from queue_entries where branch_id = $1`, [id]);
        }
        if (hasMedia) {
          await client.query(
            `delete from media_assets where barber_id in (select id from barbers where branch_id = $1)`,
            [id]
          );
        }
        // Remove logins of the branch's barbers, then the barbers (verifix cascades)
        await client.query(`delete from users where id in (select id from barbers where branch_id = $1)`, [id]);
        await client.query(`delete from barbers where branch_id = $1`, [id]);
        // Detach any remaining staff (managers/admins) so we don't nuke their accounts
        await client.query(`update users set branch_id = null where branch_id = $1`, [id]);
      } else {
        // Keep everything, just detach it from the branch being removed
        if (hasQueue) {
          await client.query(`update queue_entries set branch_id = null where branch_id = $1`, [id]);
        }
        await client.query(`update users set branch_id = null where branch_id = $1`, [id]);
        await client.query(`update barbers set branch_id = null where branch_id = $1`, [id]);
      }

      await client.query(
        `delete from branches where id = $1 and marketplace_barbershop_id = $2`,
        [id, access.barbershopId]
      );

      await client.query('COMMIT');
      return res.json({ deleted: true, id, purged: purge });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      return res.status(500).json({ error: error.message });
    } finally {
      client.release();
    }
  }

  async listBarbers(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    try {
      const includeInactive = parseBoolean(req.query?.include_inactive, true);
      const params = [access.barbershopId];
      const activeFilter = includeInactive === false ? 'and b.is_active = true' : '';
      const result = await db.query(
        `select b.id, b.name, b.branch_id, b.phone, b.specialization, b.photo_url, b.is_active, b.created_at, b.updated_at
         from barbers b
         join branches br on br.id = b.branch_id and br.marketplace_barbershop_id = $1
         where true ${activeFilter}
         order by b.name asc`,
        params
      );
      const items = result.rows.map(barberItem);
      return res.json({ items, total: items.length });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async createBarber(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    let normalized;
    try {
      normalized = await barberPayload(req.body || {}, { barbershopId: access.barbershopId });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
    if (normalized.error) return res.status(400).json({ error: normalized.error });

    const payload = normalized.payload;
    try {
      const result = await db.query(
        `insert into barbers (name, branch_id, phone, specialization, photo_url, is_active, is_authorized, is_on_shift)
         values ($1, $2, $3, $4, $5, $6, true, false)
         returning id, name, branch_id, phone, specialization, photo_url, is_active, created_at, updated_at`,
        [
          payload.name,
          payload.branch_id,
          payload.phone || null,
          payload.specialization || null,
          payload.photo_url || null,
          payload.is_active,
        ]
      );
      return res.status(201).json({ item: barberItem(result.rows[0]) });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async updateBarber(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Barber id is required' });

    let normalized;
    try {
      normalized = await barberPayload(req.body || {}, {
        barbershopId: access.barbershopId,
        partial: true,
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const payload = normalized.payload;
    if (!Object.keys(payload).length) return res.status(400).json({ error: 'No fields to update' });

    try {
      payload.updated_at = new Date().toISOString();
      const keys = Object.keys(payload);
      const values = keys.map((key) => payload[key]);
      const setSql = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
      const result = await db.query(
        `update barbers b
         set ${setSql}
         from branches br
         where b.id = $${keys.length + 1}
           and br.id = b.branch_id
           and br.marketplace_barbershop_id = $${keys.length + 2}
         returning b.id, b.name, b.branch_id, b.phone, b.specialization, b.photo_url, b.is_active, b.created_at, b.updated_at`,
        [...values, id, access.barbershopId]
      );

      if (!result.rows[0]) return res.status(404).json({ error: 'Barber not found' });
      return res.json({ item: barberItem(result.rows[0]) });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async deleteBarber(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Barber id is required' });

    // hard = true  -> full purge: also removes the barber's queue visits and their payments
    // hard = false -> keep statistics: detach visits, remove only the barber + login/access
    const purge = parseBoolean(req.query?.hard ?? req.body?.hard, false) === true;

    const client = await pool.connect();
    const tableExists = async (name) => {
      const r = await client.query('select to_regclass($1) as reg', [name]);
      return Boolean(r.rows[0]?.reg);
    };

    try {
      await client.query('BEGIN');

      // Ownership: barber must belong to a branch of this merchant's barbershop
      const owned = await client.query(
        `select b.id
         from barbers b
         join branches br on br.id = b.branch_id and br.marketplace_barbershop_id = $2
         where b.id = $1`,
        [id, access.barbershopId]
      );
      if (!owned.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Barber not found' });
      }

      const hasQueue = await tableExists('queue_entries');
      if (hasQueue) {
        if (purge) {
          if (await tableExists('payments')) {
            await client.query(
              `delete from payments where queue_entry_id in (select id from queue_entries where barber_id = $1)`,
              [id]
            );
          }
          await client.query(`delete from queue_entries where barber_id = $1`, [id]);
        } else {
          await client.query(`update queue_entries set barber_id = null where barber_id = $1`, [id]);
        }
      }

      // Barber-owned artifacts (blocks the delete via FK); safe to drop in both modes
      if (await tableExists('media_assets')) {
        await client.query(`delete from media_assets where barber_id = $1`, [id]);
      }

      // Remove the barber profile (verifix rows cascade / set null via their FK rules)
      await client.query(`delete from barbers where id = $1`, [id]);
      // Remove the login/access — the users row shares the barber id; user_permissions cascade
      await client.query(`delete from users where id = $1`, [id]);

      await client.query('COMMIT');
      return res.json({ deleted: true, id, purged: purge });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      return res.status(500).json({ error: error.message });
    } finally {
      client.release();
    }
  }

  async listCategories(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    try {
      const includeInactive = parseBoolean(req.query?.include_inactive, true);
      const activeFilter = includeInactive === false ? 'and is_active = true' : '';
      const result = await db.query(
        `select id, name, sort_order, is_active, created_at, updated_at
         from service_categories
         where marketplace_barbershop_id = $1 ${activeFilter}
         order by sort_order asc, name asc`,
        [access.barbershopId]
      );
      const items = result.rows.map(categoryItem);
      return res.json({ items, total: items.length });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async createCategory(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    const { payload, error: payloadError } = categoryPayload(req.body || {}, {
      barbershopId: access.barbershopId,
    });
    if (payloadError) return res.status(400).json({ error: payloadError });

    try {
      const result = await db.query(
        `insert into service_categories (name, sort_order, is_active, marketplace_barbershop_id)
         values ($1, $2, $3, $4)
         returning id, name, sort_order, is_active, created_at, updated_at`,
        [payload.name, payload.sort_order, payload.is_active, access.barbershopId]
      );
      return res.status(201).json({ item: categoryItem(result.rows[0]) });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async updateCategory(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Category id is required' });

    const { payload, error: payloadError } = categoryPayload(req.body || {}, {
      barbershopId: access.barbershopId,
      partial: true,
    });
    if (payloadError) return res.status(400).json({ error: payloadError });
    if (!Object.keys(payload).length) return res.status(400).json({ error: 'No fields to update' });

    try {
      payload.updated_at = new Date().toISOString();
      const keys = Object.keys(payload);
      const values = keys.map((key) => payload[key]);
      const setSql = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
      const result = await db.query(
        `update service_categories
         set ${setSql}
         where id = $${keys.length + 1} and marketplace_barbershop_id = $${keys.length + 2}
         returning id, name, sort_order, is_active, created_at, updated_at`,
        [...values, id, access.barbershopId]
      );

      if (!result.rows[0]) return res.status(404).json({ error: 'Category not found' });
      return res.json({ item: categoryItem(result.rows[0]) });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async deleteCategory(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Category id is required' });

    try {
      const result = await db.query(
        `delete from service_categories
         where id = $1 and marketplace_barbershop_id = $2
         returning id`,
        [id, access.barbershopId]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Category not found' });
      return res.json({ deleted: true, id: result.rows[0].id });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async listServices(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    try {
      const includeInactive = parseBoolean(req.query?.include_inactive, false);
      const activeFilter = includeInactive === false ? 'and is_active = true' : '';
      const result = await db.query(
        `select id, name, duration_minutes, base_price, category, image, is_active, created_at, updated_at
         from services
         where marketplace_barbershop_id = $1 ${activeFilter}
         order by category asc nulls last, name asc`,
        [access.barbershopId]
      );
      const items = result.rows.map((row) => serviceItem(row, req));
      return res.json({ items, total: items.length });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async createService(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    const { payload, error: payloadError } = servicePayload(req.body || {}, {
      barbershopId: access.barbershopId,
    });
    if (payloadError) return res.status(400).json({ error: payloadError });

    try {
      const result = await db.query(
        `insert into services (name, duration_minutes, base_price, category, image, is_active, marketplace_barbershop_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, name, duration_minutes, base_price, category, image, is_active, created_at, updated_at`,
        [
          payload.name,
          payload.duration_minutes,
          payload.base_price,
          payload.category || null,
          normalizeImageUrl(req, payload.image) || null,
          payload.is_active,
          access.barbershopId,
        ]
      );
      return res.status(201).json({ item: serviceItem(result.rows[0], req) });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async updateService(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Service id is required' });

    const { payload, error: payloadError } = servicePayload(req.body || {}, {
      barbershopId: access.barbershopId,
      partial: true,
    });
    if (payloadError) return res.status(400).json({ error: payloadError });
    if (!Object.keys(payload).length) return res.status(400).json({ error: 'No fields to update' });

    try {
      payload.updated_at = new Date().toISOString();
      if (payload.image !== undefined) payload.image = normalizeImageUrl(req, payload.image);
      const keys = Object.keys(payload);
      const values = keys.map((key) => payload[key]);
      const setSql = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
      const result = await db.query(
        `update services
         set ${setSql}
         where id = $${keys.length + 1} and marketplace_barbershop_id = $${keys.length + 2}
         returning id, name, duration_minutes, base_price, category, image, is_active, created_at, updated_at`,
        [...values, id, access.barbershopId]
      );

      if (!result.rows[0]) return res.status(404).json({ error: 'Service not found' });
      return res.json({ item: serviceItem(result.rows[0], req) });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async deleteService(req, res) {
    const access = await requireMerchantAccess(req, res);
    if (!access) return;

    const id = normalizeId(req.params?.id);
    if (!id) return res.status(400).json({ error: 'Service id is required' });

    try {
      const result = await db.query(
        `delete from services
         where id = $1
         returning id`,
        [id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Service not found' });
      return res.json({ deleted: true, id: result.rows[0].id });
    } catch (error) {
      if (String(error.code) === '23503') {
        const result = await db.query(
          `update services
           set is_active = false, updated_at = now()
           where id = $1
           returning id`,
          [id]
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'Service not found' });
        return res.json({ deleted: true, id: result.rows[0].id, soft_deleted: true });
      }
      return res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new Merchant();
