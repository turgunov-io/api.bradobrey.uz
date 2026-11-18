// Global staff-token middleware (runs before every router, app.js).
//
// For a staff token (employee roles, merchant, platform_owner) it loads the
// user from the DB and rejects deleted/archived accounts, revoked sessions
// (session-bound roles) and — MULTI_TENANCY Phase 1 — a token/DB company
// mismatch or a suspended company. It then exposes
//   req.employeeAccess = { barber, payload, user, sessionValid }
//   req.tenant         = { companyId, isPlatformOwner }
// platform_owner (DB role) may only reach /api/platform/*; every tenant data
// route answers 403 PLATFORM_OWNER_NO_TENANT_ACCESS.
// Requests without a token, and marketplace client tokens, pass untouched.
const { getBearerToken, verifyAny } = require('../utils/authToken');
const { PLATFORM_OWNER_ROLE, checkTenantAccess, isPlatformPath } = require('../utils/tenant');

// DB-backed helpers load lazily (config/postgres needs database env at require time).
const db = () => require('../config/postgres').db;
const defaultValidateSession = (input) => require('../utils/employeeSession').validatePersistedEmployeeSession(input);

const EMPLOYEE_ACCESS_ROLES = new Set([
  'admin_network',
  'admin_branch',
  'admin',
  'manager',
  'barber',
  'super-barber',
  'super-manager',
]);

// Token roles whose account is loaded and tenant-checked on every request.
const TENANT_CHECKED_ROLES = new Set([...EMPLOYEE_ACCESS_ROLES, 'merchant', PLATFORM_OWNER_ROLE]);
const SESSION_BOUND_ROLES = new Set(['barber', 'super-barber', 'manager', 'super-manager']);

/**
 * DB state of a staff account. `user` carries company_id and company_status
 * (null for platform_owner) for checkTenantAccess().
 */
async function loadEmployeeAccessState(userId) {
  if (!userId) {
    return { barber: null, user: null };
  }

  const [{ data: user, error: userError }, { data: barber, error: barberError }] = await Promise.all([
    db()
      .from('users')
      .select('id, login, role, branch_id, company_id')
      .eq('id', userId)
      .maybeSingle(),
    db()
      .from('barbers')
      .select('id, branch_id, is_active, is_authorized, is_archived, is_on_shift')
      .eq('id', userId)
      .maybeSingle(),
  ]);

  if (userError) throw new Error(userError.message);
  if (barberError) throw new Error(barberError.message);
  if (!user) return { barber: barber || null, user: null };

  let companyStatus = null;
  if (user.company_id) {
    const { data: company, error: companyError } = await db()
      .from('companies')
      .select('id, status')
      .eq('id', user.company_id)
      .maybeSingle();
    if (companyError) throw new Error(companyError.message);
    companyStatus = company?.status || null;
  }

  return { barber: barber || null, user: { ...user, company_status: companyStatus } };
}

function isArchivedEmployee(barber) {
  // `is_active` is the operational availability flag (for example, a break
  // sets it to false). `is_authorized` predates employee archiving and is
  // still used by existing integrations. Neither one must revoke a login.
  return barber?.is_archived === true;
}

/**
 * Shared post-load check for guards that load the account themselves
 * (adminAuth, kioskAuth, kioskRegistration): archived, tenant.
 * @returns {{ ok: true, tenant: object } | { ok: false, status: number, body: object }}
 */
function checkLoadedStaff({ payload, state }) {
  if (!state?.user) return { ok: false, status: 401, body: { error: 'Session is no longer valid' } };
  if (isArchivedEmployee(state.barber)) {
    return { ok: false, status: 403, body: { error: 'Employee access has been revoked' } };
  }
  return checkTenantAccess({ payload, user: state.user });
}

function createEmployeeAccessMiddleware({
  loadState = loadEmployeeAccessState,
  validateSession = defaultValidateSession,
  secret,
} = {}) {
  return async function enforceEmployeeAccess(req, res, next) {
    const token = getBearerToken(req);

    if (!token) {
      next();
      return;
    }

    let payload;
    try {
      payload = verifyAny(token, { secret });
    } catch (_error) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const role = String(payload?.role || '').trim();
    if (!TENANT_CHECKED_ROLES.has(role)) {
      next();
      return;
    }

    const userId = payload?.sub || payload?.id;

    try {
      const { barber, user } = await loadState(userId);

      const staffCheck = checkLoadedStaff({ payload, state: { barber, user } });
      if (!staffCheck.ok) {
        res.status(staffCheck.status).json(staffCheck.body);
        return;
      }
      const { tenant } = staffCheck;

      if (String(user.role || '').trim().toLowerCase() === PLATFORM_OWNER_ROLE && !isPlatformPath(req)) {
        res.status(403).json({ code: 'PLATFORM_OWNER_NO_TENANT_ACCESS', error: 'Platform owner has no access to company data' });
        return;
      }

      if (SESSION_BOUND_ROLES.has(role)) {
        let session;
        try {
          session = await validateSession({
            employeeId: userId,
            branchId: payload?.branchId,
            sessionId: payload?.jti,
            role,
          });
        } catch (_error) {
          res.status(503).json({ code: 'SESSION_VALIDATION_UNAVAILABLE', error: 'Session validation is temporarily unavailable' });
          return;
        }

        if (!session.valid) {
          const blocked = ['account_blocked', 'branch_access_revoked'].includes(session.reason);
          const isLogoutReplay = req.method === 'POST'
            && String(req.originalUrl || req.path || '').split('?')[0].endsWith('/api/barbers/logout')
            && session.reason === 'revoked';
          if (isLogoutReplay) {
            req.employeeAccess = { barber, payload, user, sessionValid: false };
            req.tenant = tenant;
            next();
            return;
          }
          const code = session.reason === 'expired'
            ? 'SESSION_EXPIRED'
            : blocked ? 'ACCOUNT_BLOCKED' : 'SESSION_REVOKED';
          res.status(blocked ? 403 : 401).json({ code, error: 'Employee session is no longer valid' });
          return;
        }
      }

      req.employeeAccess = { barber, payload, user, sessionValid: true };
      req.tenant = tenant;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message || 'Failed to validate employee access' });
    }
  };
}

const enforceEmployeeAccess = createEmployeeAccessMiddleware();

module.exports = {
  EMPLOYEE_ACCESS_ROLES,
  TENANT_CHECKED_ROLES,
  checkLoadedStaff,
  createEmployeeAccessMiddleware,
  enforceEmployeeAccess,
  isArchivedEmployee,
  loadEmployeeAccessState,
};
