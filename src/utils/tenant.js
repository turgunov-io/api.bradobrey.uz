// Company (tenant) helpers — MULTI_TENANCY Phase 1 step B1.
//
//   checkTenantAccess({ payload, user })  pure: compares the verified token
//       claims with the DB-loaded user ({ role, company_id, company_status })
//       and returns { ok: true, tenant } or { ok: false, status, body }.
//       tenant = { companyId, isPlatformOwner } is what routes see as req.tenant.
//   companyRepo                          pg lookups (companies, their branches).
//   normalizeCompanyCode(value)          trimmed code, or '' when malformed.
//
// The company always comes from the DB (users.company_id); a token's
// `companyId` claim is only cross-checked. Old tokens without the claim are
// accepted (they expire within JWT_EXPIRES_IN, 12h by default).
const PLATFORM_OWNER_ROLE = 'platform_owner';
const COMPANY_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;

const normalizeRole = (value) => String(value || '').trim().toLowerCase();
const normalizeId = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

function normalizeCompanyCode(value) {
  if (typeof value !== 'string') return '';
  const code = value.trim();
  return COMPANY_CODE_PATTERN.test(code) ? code : '';
}

const deny = (status, code, error) => ({ ok: false, status, body: { code, error } });

/**
 * @param {{ payload?: Record<string, any>, user?: { role?: string, company_id?: string|null, company_status?: string|null } }} input
 * @returns {{ ok: true, tenant: { companyId: string|null, isPlatformOwner: boolean } } | { ok: false, status: number, body: { code: string, error: string } }}
 */
function checkTenantAccess({ payload, user } = {}) {
  const role = normalizeRole(user?.role);
  const claimedCompanyId = normalizeId(payload?.companyId);
  const companyId = normalizeId(user?.company_id);

  if (role === PLATFORM_OWNER_ROLE) {
    if (companyId) return deny(403, 'COMPANY_MEMBERSHIP_INVALID', 'Platform owner must not belong to a company');
    if (claimedCompanyId) return deny(401, 'TOKEN_COMPANY_MISMATCH', 'Token company does not match the account');
    return { ok: true, tenant: { companyId: null, isPlatformOwner: true } };
  }

  if (!companyId) return deny(403, 'COMPANY_REQUIRED', 'Account is not assigned to a company');
  if (claimedCompanyId && claimedCompanyId.toLowerCase() !== companyId.toLowerCase()) {
    return deny(401, 'TOKEN_COMPANY_MISMATCH', 'Token company does not match the account');
  }
  if (user?.company_status !== 'active') {
    return deny(403, 'COMPANY_SUSPENDED', 'Company access is suspended');
  }
  return { ok: true, tenant: { companyId, isPlatformOwner: false } };
}

const isPlatformPath = (req) => {
  const path = String(req?.originalUrl || req?.path || '').split('?')[0];
  return path === '/api/platform' || path.startsWith('/api/platform/');
};

// Resolved lazily: config/postgres needs database env at require time.
const pool = () => require('../config/postgres').pool;

const PUBLIC_COMPANY_COLUMNS = 'id, name, code, logo_url, primary_color, currency';

const companyRepo = {
  // Active company by code (case-insensitive), or null.
  async findActiveByCode(code) {
    const result = await pool().query(
      `select ${PUBLIC_COMPANY_COLUMNS}, timezone, status, is_default
         from companies
        where lower(code) = lower($1) and status = 'active'
        limit 1`,
      [code],
    );
    return result.rows[0] || null;
  },

  async findDefault() {
    const result = await pool().query(
      `select ${PUBLIC_COMPANY_COLUMNS}, timezone, status, is_default
         from companies
        where is_default
        limit 1`,
    );
    return result.rows[0] || null;
  },

  async countCompanies() {
    const result = await pool().query('select count(*)::int as count from companies');
    return Number(result.rows[0]?.count || 0);
  },

  async listActiveBranches(companyId) {
    const result = await pool().query(
      `select id, name, address
         from branches
        where company_id = $1 and is_active = true
        order by name asc, id asc`,
      [companyId],
    );
    return result.rows;
  },

  // All branches of the company (closed ones too: historical data stays visible).
  async listBranchIds(companyId) {
    if (!companyId) return [];
    const result = await pool().query('select id from branches where company_id = $1', [companyId]);
    return result.rows.map((row) => String(row.id));
  },

  // { id, company_id, is_active } or null.
  async findBranch(branchId) {
    const result = await pool().query(
      'select id, company_id, is_active from branches where id = $1 limit 1',
      [branchId],
    );
    return result.rows[0] || null;
  },

  // companies.kiosk_enrollment_code_hash (migration 008), or null. Never
  // part of any response.
  async findKioskEnrollmentHash(companyId) {
    const result = await pool().query(
      'select kiosk_enrollment_code_hash from companies where id = $1 limit 1',
      [companyId],
    );
    return result.rows[0]?.kiosk_enrollment_code_hash || null;
  },

  // Company admins rotate their own code; true when the company exists.
  async setKioskEnrollmentHash(companyId, hash) {
    const result = await pool().query(
      'update companies set kiosk_enrollment_code_hash = $2, updated_at = now() where id = $1',
      [companyId, hash],
    );
    return result.rowCount > 0;
  },
};

const COMPANY_NOT_FOUND = Object.freeze({ code: 'COMPANY_NOT_FOUND', error: 'Company not found' });

/**
 * Company for a staff login (barber app, dash). With a code: the active
 * company or 404 (unknown and suspended look the same). Without a code
 * (legacy barber app, dash): the default company, with a warning — only while
 * it is the only company (counted on every call, no cache); with 2+ companies
 * 400 COMPANY_CODE_REQUIRED (security review M4).
 * @returns {Promise<{ company: object, legacy: boolean } | { error: { status: number, body: object } }>}
 */
async function resolveLoginCompany(companyCode, { repo = companyRepo, warn = console.warn } = {}) {
  const provided = companyCode !== undefined && companyCode !== null && companyCode !== '';
  if (provided) {
    const code = normalizeCompanyCode(companyCode);
    const company = code ? await repo.findActiveByCode(code) : null;
    if (!company) return { error: { status: 404, body: { ...COMPANY_NOT_FOUND } } };
    return { company, legacy: false };
  }
  const codeRequired = { error: { status: 400, body: { code: 'COMPANY_CODE_REQUIRED', error: 'company_code is required' } } };
  if ((await repo.countCompanies()) !== 1) return codeRequired;
  const fallback = await repo.findDefault();
  if (!fallback) return codeRequired;
  if (fallback.status !== 'active') {
    return { error: { status: 403, body: { code: 'COMPANY_SUSPENDED', error: 'Company access is suspended' } } };
  }
  warn('[auth] staff login without company_code: using the default company (legacy client)');
  return { company: fallback, legacy: true };
}

module.exports = {
  COMPANY_CODE_PATTERN,
  COMPANY_NOT_FOUND,
  resolveLoginCompany,
  PLATFORM_OWNER_ROLE,
  checkTenantAccess,
  companyRepo,
  isPlatformPath,
  normalizeCompanyCode,
};
