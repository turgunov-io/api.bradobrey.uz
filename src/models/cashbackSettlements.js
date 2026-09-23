const jwt = require('jsonwebtoken');

const { pool } = require('../config/postgres');

const ADMIN_ROLES = new Set(['admin_network', 'admin_branch', 'admin', 'merchant']);
const TERMINAL_STATUSES = new Set(['SETTLED', 'REVERSED']);

function getBearerToken(req) {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : null;
}

function requireAdmin(req, res) {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (_error) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }

  if (!ADMIN_ROLES.has(payload?.role)) {
    res.status(403).json({ error: 'Only admins can manage cashback settlements' });
    return null;
  }

  return payload;
}

function normalizeId(value) {
  const text = String(value || '').trim();
  return text || null;
}

function scopedBranchId(auth, requested) {
  const ownBranch = normalizeId(auth?.branch_id || auth?.branchId);
  const branchId = normalizeId(requested);
  if (auth?.role === 'admin_branch') return ownBranch;
  return branchId;
}

function canAccessBranch(auth, branchId) {
  if (auth?.role !== 'admin_branch') return true;
  const ownBranch = normalizeId(auth?.branch_id || auth?.branchId);
  const targetBranch = normalizeId(branchId);
  return Boolean(ownBranch && targetBranch && ownBranch === targetBranch);
}

class CashbackSettlements {
  async list(req, res) {
    const auth = requireAdmin(req, res);
    if (!auth) return;

    const status = String(req.query?.status || '').trim().toUpperCase();
    if (status && !['PENDING', 'SETTLED', 'REVERSED'].includes(status)) {
      return res.status(400).json({ error: 'status must be PENDING, SETTLED or REVERSED' });
    }

    const requestedBranch = normalizeId(req.query?.branch_id);
    if (auth.role === 'admin_branch' && !normalizeId(auth.branch_id || auth.branchId)) {
      return res.status(403).json({ error: 'Branch scope is missing for the administrator' });
    }
    if (auth.role === 'admin_branch' && requestedBranch && !canAccessBranch(auth, requestedBranch)) {
      return res.status(403).json({ error: 'Settlement is outside the administrator branch scope' });
    }

    const params = [];
    const filters = [];
    const branchId = scopedBranchId(auth, requestedBranch);
    if (branchId) {
      params.push(branchId);
      filters.push(`s.branch_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      filters.push(`s.status = $${params.length}`);
    }
    const where = filters.length ? `where ${filters.join(' and ')}` : '';
    const limit = Math.min(Math.max(Number(req.query?.limit) || 100, 1), 500);
    params.push(limit);

    try {
      const result = await pool.query(
        `select s.id, s.queue_entry_id, s.branch_id, b.name as branch_name,
                s.client_id, s.cashback_amount, s.status, s.settled_at,
                s.processed_at, s.processed_by, s.metadata, s.created_at, s.updated_at
           from cashback_settlements s
           left join branches b on b.id = s.branch_id
           ${where}
          order by s.created_at desc
          limit $${params.length}`,
        params,
      );
      return res.json({ settlements: result.rows });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async process(req, res) {
    const auth = requireAdmin(req, res);
    if (!auth) return;

    const id = normalizeId(req.params?.id);
    const nextStatus = String(req.body?.status || '').trim().toUpperCase();
    if (!id || !TERMINAL_STATUSES.has(nextStatus)) {
      return res.status(400).json({ error: 'status must be SETTLED or REVERSED' });
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      const locked = await client.query(
        `select id, branch_id, status, metadata
           from cashback_settlements
          where id = $1
          for update`,
        [id],
      );
      const row = locked.rows[0];
      if (!row) {
        await client.query('rollback');
        return res.status(404).json({ error: 'Cashback settlement not found' });
      }
      if (!canAccessBranch(auth, row.branch_id)) {
        await client.query('rollback');
        return res.status(403).json({ error: 'Settlement is outside the administrator branch scope' });
      }
      if (row.status === nextStatus) {
        await client.query('commit');
        return res.json({ settlement: row, idempotent: true });
      }
      if (row.status !== 'PENDING') {
        await client.query('rollback');
        return res.status(409).json({ error: 'Settlement is already finalized' });
      }

      const processedBy = normalizeId(auth.sub || auth.id) || String(auth.login || 'admin');
      const metadata = {
        ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
        processed_by_role: auth.role,
      };
      const updated = await client.query(
        `update cashback_settlements
            set status = $2,
                processed_at = now(),
                processed_by = $3,
                settled_at = case when $2 = 'SETTLED' then now() else settled_at end,
                metadata = $4::jsonb,
                updated_at = now()
          where id = $1
          returning *`,
        [id, nextStatus, processedBy, JSON.stringify(metadata)],
      );
      await client.query(
        `insert into marketplace_audit_logs
          (action, entity_type, entity_id, metadata)
         values ($1, 'cashback_settlement', $2, $3::jsonb)`,
        [`CASHBACK_SETTLEMENT_${nextStatus}`, id, JSON.stringify({ processed_by: processedBy, role: auth.role })],
      );
      await client.query('commit');
      return res.json({ settlement: updated.rows[0], idempotent: false });
    } catch (error) {
      try { await client.query('rollback'); } catch (_rollbackError) { /* no-op */ }
      return res.status(500).json({ error: error.message });
    } finally {
      client.release();
    }
  }
}

module.exports = new CashbackSettlements();
