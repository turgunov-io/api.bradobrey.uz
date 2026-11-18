// Admin authorization helpers.
//
//   authorizeAdmin(req, res)       async; verifies the JWT, then loads the
//                                  caller's role and archived status from the
//                                  database (never trusts the token's role).
//   createAdminAuth(opts)          factory for authorizeAdmin with custom roles
//                                  and a caller-specific 403 message.
//   createNetworkWriteAuth(opts)   admin auth that additionally requires a
//                                  network role (network-wide settings writes).
//   resolveAllowedBranchIds(user)  branch scope of a DB-loaded user
//                                  ({ id, role, branch_id, company_id }): the
//                                  list of branch ids the user may act on.
//                                  Network roles get every branch of THEIR
//                                  company (MULTI_TENANCY Phase 1), marked
//                                  isCompanyWideScope(); never null.
//   isBranchAllowed(scope, id)     membership check against that scope.
const { getBearerToken, verifyAny } = require('./authToken');
const { PLATFORM_OWNER_ROLE, checkTenantAccess } = require('./tenant');

// DB-backed helpers are required lazily: config/postgres throws at load time
// without database env, and token-only callers/tests must not need it.
const employeeAccess = () => require('../middleware/employeeAccess');
const employeeBranches = () => require('./employeeBranches');
const queryDb = (sql, params) => require('../config/postgres').db.query(sql, params);

// Canonical network-wide roles (admin_network, admin, super-manager).
const networkRoles = () => require('./employeeQualityAccess').NETWORK_ROLES;

const ADMIN_ROLES = new Set(['admin_network', 'admin_branch', 'admin', 'merchant']);

// users.id is a uuid column; reject other subjects before querying.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const normalizeRole = (role) => String(role || '').trim().toLowerCase();
const isNetworkRole = (role) => networkRoles().has(normalizeRole(role));

function verifyToken(req, res, secret) {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }
  try {
    const jwtSecret = secret || process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error('JWT_SECRET is not configured');
    return verifyAny(token, { secret: jwtSecret });
  } catch (_err) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
}

function createAdminAuth({
  loadState = (userId) => employeeAccess().loadEmployeeAccessState(userId),
  isArchived = (barber) => employeeAccess().isArchivedEmployee(barber),
  secret,
  roles = ADMIN_ROLES,
  forbiddenMessage = 'Only admins can perform this action',
} = {}) {
  return async function authorizeAdmin(req, res) {
    const payload = verifyToken(req, res, secret);
    if (!payload) return null;

    const userId = String(payload?.sub || payload?.id || '');
    if (!UUID_PATTERN.test(userId)) {
      res.status(401).json({ error: 'Invalid token payload' });
      return null;
    }

    let state;
    try {
      state = await loadState(userId);
    } catch (error) {
      console.error('[admin-auth] authorization failed:', error?.code || error?.message);
      res.status(500).json({ error: 'Failed to authorize request' });
      return null;
    }

    if (!state?.user) {
      res.status(401).json({ error: 'Session is no longer valid' });
      return null;
    }
    if (isArchived(state.barber)) {
      res.status(403).json({ error: 'Employee access has been revoked' });
      return null;
    }
    const tenantCheck = checkTenantAccess({ payload, user: state.user });
    if (!tenantCheck.ok) {
      res.status(tenantCheck.status).json(tenantCheck.body);
      return null;
    }

    const role = normalizeRole(state.user.role);
    if (!roles.has(role)) {
      res.status(403).json({ error: forbiddenMessage });
      return null;
    }

    return {
      ...payload,
      branch_id: state.user.branch_id || null,
      company_id: tenantCheck.tenant.companyId,
      companyId: tenantCheck.tenant.companyId,
      tenant: tenantCheck.tenant,
      id: state.user.id,
      role,
      sub: state.user.id,
    };
  };
}

const authorizeAdmin = createAdminAuth();

// Any admin role passes the base check (so readers keep working); the write
// additionally requires a network role because the setting is network-wide.
function createNetworkWriteAuth({
  networkMessage = 'Only network administrators can change this setting',
  roles = new Set([...ADMIN_ROLES, ...networkRoles()]),
  ...adminAuthOptions
} = {}) {
  const authorize = createAdminAuth({ ...adminAuthOptions, roles });
  return async function authorizeNetworkWrite(req, res) {
    const auth = await authorize(req, res);
    if (!auth) return null;
    if (!isNetworkRole(auth.role)) {
      res.status(403).json({ error: networkMessage });
      return null;
    }
    return auth;
  };
}

// Company-wide scopes are plain arrays; the marker lets a few legacy
// handlers keep treating company-level rows (branch_id NULL) as in scope.
function markCompanyWide(ids) {
  Object.defineProperty(ids, 'companyWide', { value: true, enumerable: false });
  return ids;
}
const isCompanyWideScope = (scope) => Array.isArray(scope) && scope.companyWide === true;

async function loadCompanyBranchIds(companyId, query) {
  if (!companyId) return [];
  const result = await query('select id from branches where company_id = $1', [companyId]);
  return (result.rows || []).map((row) => String(row.id));
}

async function loadMerchantBranchIds(user, query) {
  try {
    const result = await query(
      `select b.id
         from branches b
         join users u on u.marketplace_barbershop_id = b.marketplace_barbershop_id
        where u.id = $1
          and b.company_id = u.company_id`,
      [user.id],
    );
    const ids = (result.rows || []).map((row) => String(row.id));
    if (user.branch_id && !ids.includes(String(user.branch_id))) ids.push(String(user.branch_id));
    return ids;
  } catch (error) {
    if (String(error?.code || '') !== '42703') throw error; // undefined column
    return user.branch_id ? [String(user.branch_id)] : [];
  }
}

/**
 * @param {{ id: string, role: string, branch_id?: string|null, company_id?: string|null }} user DB-loaded user
 * @returns {Promise<string[]>} allowed branch ids (network roles: whole company)
 */
async function resolveAllowedBranchIds(user, {
  listBranches = (id, fallback) => employeeBranches().listEmployeeBranches(id, fallback),
  query = queryDb,
} = {}) {
  if (!user?.id) return [];
  const role = normalizeRole(user.role);
  if (role === PLATFORM_OWNER_ROLE) return [];
  if (networkRoles().has(role)) return markCompanyWide(await loadCompanyBranchIds(user.company_id, query));
  if (role === 'merchant') return loadMerchantBranchIds(user, query);

  const branches = await listBranches(user.id, user.branch_id || null);
  return (branches || []).map((branch) => String(branch.id));
}

// Session-bound roles (manager, barbers) work in the branch selected at login,
// which enforceEmployeeAccess validates on every request; keep them pinned to
// it. Other branch roles (admin_branch, merchant) get their allowed set.
const SESSION_BRANCH_ROLES = new Set(['manager', 'barber', 'super-barber']);

/**
 * @param {{ id: string, role: string, branch_id?: string|null }} user DB-loaded user
 * @param {string|null} sessionBranchId branch from the validated session token
 * @returns {Promise<string[]|null>}
 */
async function resolveStaffBranchScope(user, sessionBranchId, deps) {
  const role = normalizeRole(user?.role);
  if (networkRoles().has(role)) return resolveAllowedBranchIds(user, deps);
  if (SESSION_BRANCH_ROLES.has(role)) return sessionBranchId ? [String(sessionBranchId)] : [];
  return resolveAllowedBranchIds(user, deps);
}

const isBranchAllowed = (scope, branchId) => (
  scope === null || (branchId !== null && branchId !== undefined && scope.includes(String(branchId)))
);

// Express middleware: resolves req.branchScope for the caller loaded by a
// preceding staffAccess guard (req.staffAccess): company-scoped branch ids.
function createBranchScopeMiddleware({ resolve = resolveAllowedBranchIds } = {}) {
  return async function attachBranchScope(req, res, next) {
    const access = req.staffAccess;
    if (!access?.actor?.id) {
      res.status(401).json({ error: 'Authorization token is required' });
      return;
    }
    try {
      req.branchScope = await resolve({ ...access.actor, role: access.role || access.actor.role });
      next();
    } catch (error) {
      console.error('[branch-scope] resolution failed:', error?.code || error?.message);
      res.status(500).json({ error: 'Failed to authorize request' });
    }
  };
}

const attachBranchScope = createBranchScopeMiddleware();

// Express middleware for routers whose models still parse the token
// themselves (verifix, kioskAds). For a valid employee token it loads the
// caller from the database and sets
//   req.dbActor = { id, role, branch_id, branchScope, companyId } (+ req.tenant)
// with the DB role and branch scope. A missing or invalid token passes
// through untouched so the model keeps answering 401 itself; a token whose
// user is gone or archived is rejected here.
function createDbActorMiddleware({
  loadState = (userId) => employeeAccess().loadEmployeeAccessState(userId),
  isArchived = (barber) => employeeAccess().isArchivedEmployee(barber),
  resolveScope = resolveStaffBranchScope,
  secret,
} = {}) {
  return async function attachDbActor(req, res, next) {
    const token = getBearerToken(req);
    let payload = null;
    try {
      const jwtSecret = secret || process.env.JWT_SECRET;
      if (token && jwtSecret) payload = verifyAny(token, { secret: jwtSecret });
    } catch (_error) {
      payload = null;
    }
    const userId = String(payload?.sub || payload?.id || '');
    if (!payload || !UUID_PATTERN.test(userId)) {
      next();
      return;
    }

    try {
      const state = await loadState(userId);
      if (!state?.user) {
        res.status(401).json({ error: 'Session is no longer valid' });
        return;
      }
      if (isArchived(state.barber)) {
        res.status(403).json({ error: 'Employee access has been revoked' });
        return;
      }
      const tenantCheck = checkTenantAccess({ payload, user: state.user });
      if (!tenantCheck.ok) {
        res.status(tenantCheck.status).json(tenantCheck.body);
        return;
      }
      const role = normalizeRole(state.user.role);
      const sessionBranchId = payload.branchId || payload.branch_id || state.user.branch_id || null;
      const branchScope = await resolveScope({ ...state.user, role }, sessionBranchId);
      req.tenant = tenantCheck.tenant;
      req.dbActor = {
        branch_id: state.user.branch_id || null,
        branchScope,
        companyId: tenantCheck.tenant.companyId,
        id: state.user.id,
        role,
        sessionBranchId,
      };
      next();
    } catch (error) {
      console.error('[db-actor] authorization failed:', error?.code || error?.message);
      res.status(500).json({ error: 'Failed to authorize request' });
    }
  };
}

const attachDbActor = createDbActorMiddleware();

module.exports = {
  ADMIN_ROLES,
  attachBranchScope,
  attachDbActor,
  createBranchScopeMiddleware,
  createDbActorMiddleware,
  authorizeAdmin,
  createAdminAuth,
  createNetworkWriteAuth,
  isBranchAllowed,
  isCompanyWideScope,
  isNetworkRole,
  resolveAllowedBranchIds,
  resolveStaffBranchScope,
};
