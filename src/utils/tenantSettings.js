// Company-scoped platform_settings — MULTI_TENANCY Phase 1 step B2.
//
// platform_settings is keyed by (company_id, key) (PK after migration 007).
// Reads go through the SQL function tenant_setting(key, company) from
// migration 005. The company always comes from the row being processed
// (branch, queue entry, booking, referral account) — never "the row with this
// key" (after 007 that would be an arbitrary company's row).
//
// No company => null: callers fall back to their built-in defaults, so one
// company's settings never leak into another's processing.

const { companyIdOfBranch, legacyDefaultCompanyId } = require('./companyScope');

const pool = () => require('../config/postgres').pool;

/**
 * platform_settings value of one company, or null.
 * @param {{ query: Function }|null} queryable pg client inside a transaction, or null for the pool
 * @param {string} key
 * @param {string|null} companyId
 * @returns {Promise<object|null>}
 */
async function readTenantSetting(queryable, key, companyId) {
  if (!companyId) return null;
  const runner = queryable || pool();
  const result = await runner.query('select tenant_setting($1, $2::uuid) as value', [key, companyId]);
  return result.rows?.[0]?.value ?? null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Company for a marketplace (ŞAF) request that has no booking/branch row to
 * derive it from (loyalty screen, restriction status, own referral code):
 *   ?branch_id (or body.branch_id) -> that branch's company;
 *   otherwise the default company while exactly one company exists;
 *   otherwise null (also for an unknown/malformed branch) — the caller
 *   answers 400 BRANCH_REQUIRED, same contract as GET /api/loyalty/ranks and
 *   GET /api/kiosk/certificate/:id.
 * @returns {Promise<string|null>}
 */
async function resolveMarketplaceContextCompanyId(req) {
  const branchId = String(req?.query?.branch_id || req?.body?.branch_id || '').trim();
  if (branchId) return UUID_PATTERN.test(branchId) ? companyIdOfBranch(branchId) : null;
  return legacyDefaultCompanyId();
}

const COMPANY_CONTEXT_REQUIRED = Object.freeze({
  code: 'BRANCH_REQUIRED',
  error: 'branch_id is required',
});

module.exports = {
  COMPANY_CONTEXT_REQUIRED,
  readTenantSetting,
  resolveMarketplaceContextCompanyId,
};
