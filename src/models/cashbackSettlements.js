// Cashback settlements (routers/cashbackSettlements.js, /api/finance/cashback-settlements).
//
// Authorization (MULTI_TENANCY 0.6, H2): the caller is loaded from the DB by
// createAdminAuth (role + archived status from the DB, never the token).
// MULTI_TENANCY B2: every query is bound to the caller's company (network
// roles = whole company, rows with branch_id NULL included).
// Network roles are unrestricted within it; admin_branch / merchant are limited to
// resolveAllowedBranchIds() — an out-of-scope branch is 403, no branch lists
// only the allowed branches.
const { createAdminAuth, isBranchAllowed, isCompanyWideScope, resolveAllowedBranchIds } = require('../utils/adminAuth');
const { NETWORK_ROLES } = require('../utils/employeeQualityAccess');

const SETTLEMENT_ROLES = new Set([...NETWORK_ROLES, 'admin_network', 'admin_branch', 'admin', 'merchant']);
const TERMINAL_STATUSES = new Set(['SETTLED', 'REVERSED']);

const defaultAuthorize = createAdminAuth({
  roles: SETTLEMENT_ROLES,
  forbiddenMessage: 'Only admins can manage cashback settlements',
});
// Resolved lazily so the module can load without database env.
const defaultPool = () => require('../config/postgres').pool;

function normalizeId(value) {
  const text = String(value || '').trim();
  return text || null;
}

const callerCompanyId = (auth) => normalizeId(auth?.companyId || auth?.company_id || auth?.tenant?.companyId);

const outOfScope = (res) => res.status(403).json({ error: 'Settlement is outside the administrator branch scope' });

class CashbackSettlements {
  constructor({ authorize = defaultAuthorize, resolveScope = resolveAllowedBranchIds, pool = null } = {}) {
    this.authorizeAdmin = authorize;
    this.resolveScope = resolveScope;
    this.getPool = pool ? () => pool : defaultPool;
  }

  // DB-loaded caller plus branch scope (null = unrestricted), or null after
  // an error response has been sent.
  async authorize(req, res) {
    const auth = await this.authorizeAdmin(req, res);
    if (!auth) return null;
    const companyId = callerCompanyId(auth);
    if (!companyId) {
      res.status(403).json({ code: 'COMPANY_REQUIRED', error: 'Company scope is required' });
      return null;
    }
    try {
      const branchScope = await this.resolveScope(auth);
      // A company-wide scope does not narrow by branch: the company filter
      // already applies and keeps company-level rows (branch_id NULL).
      return { ...auth, companyId, branchScope: isCompanyWideScope(branchScope) ? null : branchScope };
    } catch (error) {
      console.error('[cashback-settlements] scope resolution failed:', error?.code || error?.message);
      res.status(500).json({ error: 'Failed to authorize request' });
      return null;
    }
  }

  async list(req, res) {
    const auth = await this.authorize(req, res);
    if (!auth) return;
    const pool = this.getPool();

    const status = String(req.query?.status || '').trim().toUpperCase();
    if (status && !['PENDING', 'SETTLED', 'REVERSED'].includes(status)) {
      return res.status(400).json({ error: 'status must be PENDING, SETTLED or REVERSED' });
    }

    const requestedBranch = normalizeId(req.query?.branch_id);
    if (requestedBranch && !isBranchAllowed(auth.branchScope, requestedBranch)) return outOfScope(res);

    const params = [auth.companyId];
    const filters = ['s.company_id = $1'];
    if (requestedBranch) {
      params.push(requestedBranch);
      filters.push(`s.branch_id = $${params.length}`);
    } else if (auth.branchScope !== null) {
      params.push(auth.branchScope);
      filters.push(`s.branch_id::text = any($${params.length}::text[])`);
    }
    if (status) {
      params.push(status);
      filters.push(`s.status = $${params.length}`);
    }
    const where = `where ${filters.join(' and ')}`;
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
    const auth = await this.authorize(req, res);
    if (!auth) return;
    const pool = this.getPool();

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
          where id = $1 and company_id = $2
          for update`,
        [id, auth.companyId],
      );
      const row = locked.rows[0];
      if (!row) {
        await client.query('rollback');
        return res.status(404).json({ error: 'Cashback settlement not found' });
      }
      if (!isBranchAllowed(auth.branchScope, row.branch_id)) {
        await client.query('rollback');
        return outOfScope(res);
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

const createCashbackSettlements = (deps) => new CashbackSettlements(deps);

module.exports = new CashbackSettlements();
module.exports.createCashbackSettlements = createCashbackSettlements;
