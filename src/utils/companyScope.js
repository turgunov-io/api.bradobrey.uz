// Company (tenant) scoping for data queries — MULTI_TENANCY Phase 1 step B2a.
//
// The company of a request is NEVER taken from params/body/query. Sources, in
// order of trust:
//   req.kiosk.companyId       kiosk device token (middleware/kioskAuth)
//   req.kioskStaff.companyId  employee bearer on kiosk routes
//   req.tenant.companyId      staff token (middleware/employeeAccess, adminAuth)
// For callers without any of these (legacy kiosks without X-Kiosk-Token,
// marketplace customer app) the company is derived from the branch being
// served (branches.company_id) or, while exactly one company exists, the
// default company (legacy single-company mode). With 2+ companies and no
// branch the result is null and callers must fail closed.

// Lazily resolved: config/postgres needs database env at require time.
const db = () => require('../config/postgres').db;

const COMPANY_REQUIRED = Object.freeze({ code: 'COMPANY_REQUIRED', error: 'Company context is required' });

const normalizeId = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

/** Company from the authenticated request context only, or null. */
function tenantCompanyId(req) {
  return normalizeId(req?.kiosk?.companyId)
    || normalizeId(req?.kioskStaff?.companyId)
    || normalizeId(req?.tenant?.companyId)
    || null;
}

/** branches.company_id for a branch id, or null when the branch is unknown. */
async function companyIdOfBranch(branchId) {
  const id = normalizeId(branchId);
  if (!id) return null;
  const { data, error } = await db().from('branches').select('id, company_id').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return normalizeId(data?.company_id);
}

/**
 * Default company id while the platform has exactly one company (legacy
 * single-company mode), otherwise null. Never cached (security review M2):
 * the moment a second company exists every legacy fallback must stop.
 */
async function legacyDefaultCompanyId() {
  const { data, error } = await db().from('companies').select('id, is_default, status');
  if (error) throw new Error(error.message);
  // Suspended companies (e.g. branchless barbershops backfilled by migration
  // 001) don't end single-company mode; only a second ACTIVE company does,
  // and activating one is gated by the multi-company preconditions.
  const active = (Array.isArray(data) ? data : []).filter((row) => row?.status === 'active');
  const only = active.length === 1 && active[0]?.is_default === true ? active[0] : null;
  return normalizeId(only?.id);
}

/**
 * Company for a request: authenticated context first, then the branch being
 * served, then legacy single-company mode. null = unknown (fail closed).
 */
async function resolveRequestCompanyId(req, { branchId } = {}) {
  const fromContext = tenantCompanyId(req);
  if (fromContext) return fromContext;
  if (normalizeId(branchId)) return companyIdOfBranch(branchId);
  return legacyDefaultCompanyId();
}

/**
 * Staff routes: the tenant company or a 403 COMPANY_REQUIRED response.
 * @returns {string|null} company id, or null after responding.
 */
function requireTenantCompany(req, res) {
  const companyId = tenantCompanyId(req);
  if (companyId) return companyId;
  res.status(403).json({ ...COMPANY_REQUIRED });
  return null;
}

const sameId = (a, b) => normalizeId(a) !== null && String(a).trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

module.exports = {
  COMPANY_REQUIRED,
  companyIdOfBranch,
  legacyDefaultCompanyId,
  requireTenantCompany,
  resolveRequestCompanyId,
  sameId,
  tenantCompanyId,
};
