const { verifyAny } = require('./authToken');
const { checkTenantAccess } = require('./tenant');
const { pool } = require('../config/postgres');

const SCOPE_TYPES = new Set(['global', 'branch', 'self']);
// Platform-level roles (MULTI_TENANCY Phase 1): manage companies, never a
// company's data. Deliberately NOT part of NETWORK/BRANCH/SELF roles; only
// routers/platform.js admits it (middleware/employeeAccess blocks the rest).
const PLATFORM_ROLES = new Set(['platform_owner']);
const NETWORK_ROLES = new Set(['admin_network', 'admin', 'super-manager']);
const BRANCH_ROLES = new Set(['admin_branch', 'manager']);
const SELF_ROLES = new Set(['barber', 'super-barber']);
const REVIEW_ROLES = new Set([...NETWORK_ROLES, ...BRANCH_ROLES]);
const QUALITY_REVIEW_PERMISSION = 'statistics.quality.review';
const SUPERUSER_ROLES = new Set(['admin_network', 'admin']);
const ADMIN_PERMISSION_PRESET = [
  'dashboard.access',
  'employees.read',
  'employees.create',
  'employees.update',
  'employees.delete',
  'queue.read',
  'queue.manage.self',
  'queue.manage.branch',
  'history.read.self',
  'history.read.branch',
  'statistics.read.self',
  'statistics.read.branch',
  'statistics.read.global',
  'statistics.quality.review',
  'clients.read',
  'services.read',
  'services.manage',
  'expenses.read',
  'expenses.create',
  'expenses.update',
  'expenses.delete',
  'penalties.read',
  'penalties.create',
  'penalties.cancel',
  'promo.manage',
  'certificates.manage',
];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseCalendarDate(value) {
  const text = String(value || '').trim();
  if (!DATE_PATTERN.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
}

function addCalendarDays(value, amount) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function parseDateRange(query = {}) {
  const startDate = parseCalendarDate(query.start_date);
  const endDate = parseCalendarDate(query.end_date);
  if (!startDate || !endDate) return { error: 'start_date and end_date must be valid YYYY-MM-DD dates' };

  const startDay = Date.parse(`${startDate}T00:00:00Z`);
  const endDay = Date.parse(`${endDate}T00:00:00Z`);
  if (endDay < startDay) return { error: 'end_date must not be earlier than start_date' };
  const inclusiveDays = Math.floor((endDay - startDay) / 86400000) + 1;
  if (inclusiveDays > 366) return { error: 'Date range must not exceed 366 days' };

  return {
    endDate,
    endExclusive: `${addCalendarDays(endDate, 1)}T00:00:00+05:00`,
    startDate,
    startInclusive: `${startDate}T00:00:00+05:00`,
  };
}

const USER_WITH_COMPANY_SQL = `select u.id, u.role, u.branch_id, u.company_id, c.status as company_status
     from users u
     left join companies c on c.id = u.company_id
    where u.id = $1
    limit 1`;

async function loadCompanyBranchIds(companyId) {
  if (!companyId) return [];
  const result = await pool.query('select id from branches where company_id = $1', [companyId]);
  return (result.rows || []).map((row) => String(row.id));
}

function getBearerToken(req) {
  const header = String(req.headers?.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function effectivePermissions(role, rows = []) {
  const normalizedRole = String(role || '').trim().toLowerCase();

  // Admin accounts are superusers. An empty row set means that no per-user
  // permissions were provisioned, so preserve the role's full dashboard
  // access. A non-empty set remains authoritative for deliberate overrides.
  if (SUPERUSER_ROLES.has(normalizedRole) && rows.length === 0) {
    return new Set(ADMIN_PERMISSION_PRESET);
  }

  return new Set(rows.map((row) => String(row.permission || '')).filter(Boolean));
}

// companyBranchIds (MULTI_TENANCY Phase 1): every branch of the caller's
// company. When given, a branch scope must be one of them and the global
// scope carries { companyId, branchIds } for company-limited queries.
// authenticateStatistics always passes it.
function resolveAuthorizedScope({ permissions, query = {}, role, user, companyBranchIds }) {
  const companyBranches = Array.isArray(companyBranchIds) ? companyBranchIds.map(String) : null;
  const companyScope = companyBranches
    ? { companyId: user.company_id ? String(user.company_id) : null, branchIds: companyBranches }
    : {};
  const requestedScope = String(query.scope || '').trim().toLowerCase();
  if (!SCOPE_TYPES.has(requestedScope)) return { error: 'scope must be global, branch, or self', status: 400 };

  const userId = String(user.id);
  const userBranchId = user.branch_id ? String(user.branch_id) : null;
  const requestedEmployeeId = query.employee_id ? String(query.employee_id) : null;

  if (requestedScope === 'global') {
    if (requestedEmployeeId && !UUID_PATTERN.test(requestedEmployeeId)) {
      return { error: 'employee_id must be a UUID', status: 400 };
    }
    if (!permissions.has('statistics.read.global')) return { error: 'Missing permission: statistics.read.global', status: 403 };
    return { type: 'global', branchId: null, employeeId: requestedEmployeeId, userBranchId, userId, ...companyScope };
  }

  if (requestedScope === 'branch') {
    if (requestedEmployeeId && !UUID_PATTERN.test(requestedEmployeeId)) {
      return { error: 'employee_id must be a UUID', status: 400 };
    }
    const branchId = query.branch_id ? String(query.branch_id) : null;
    if (!branchId) return { error: 'branch_id is required for branch scope', status: 400 };
    if (!UUID_PATTERN.test(branchId)) return { error: 'branch_id must be a UUID', status: 400 };
    const global = permissions.has('statistics.read.global');
    if (!global && !permissions.has('statistics.read.branch')) {
      return { error: 'Missing permission: statistics.read.branch', status: 403 };
    }
    if (!global && (!userBranchId || branchId !== userBranchId)) {
      return { error: 'Branch scope is outside the authenticated user scope', status: 403 };
    }
    if (companyBranches && !companyBranches.includes(branchId)) {
      return { error: 'Branch scope is outside the authenticated user scope', status: 403 };
    }
    return { type: 'branch', branchId, employeeId: requestedEmployeeId, userBranchId, userId };
  }

  const canReadSelf = permissions.has('statistics.read.self')
    || permissions.has('statistics.read.branch')
    || permissions.has('statistics.read.global');
  if (!canReadSelf) return { error: 'Missing permission: statistics.read.self', status: 403 };
  return { type: 'self', branchId: userBranchId, employeeId: userId, userBranchId, userId };
}

async function authenticateStatistics(req, res, {
  authorizeQuery = null,
  requireHistory = false,
  requireRange = true,
} = {}) {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }

  let payload;
  try {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
    payload = verifyAny(token);
  } catch (_error) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }

  const userId = payload?.sub || payload?.id;
  if (!userId) {
    res.status(401).json({ error: 'Invalid token payload' });
    return null;
  }

  const userResult = await pool.query(USER_WITH_COMPANY_SQL, [userId]);
  const user = userResult.rows[0];
  if (!user) {
    res.status(401).json({ error: 'Session is no longer valid' });
    return null;
  }
  const tenantCheck = checkTenantAccess({ payload, user });
  if (!tenantCheck.ok) {
    res.status(tenantCheck.status).json(tenantCheck.body);
    return null;
  }

  const role = String(user.role || '').trim().toLowerCase();
  if (!NETWORK_ROLES.has(role) && !BRANCH_ROLES.has(role) && !SELF_ROLES.has(role)) {
    res.status(403).json({ error: 'Statistics are not available for this role' });
    return null;
  }

  const permissionResult = await pool.query(
    'select permission from user_permissions where user_id = $1',
    [userId],
  );
  const permissions = effectivePermissions(role, permissionResult.rows || []);
  const authorizationQuery = typeof authorizeQuery === 'function'
    ? authorizeQuery({ permissions, query: req.query || {}, role, user })
    : (req.query || {});
  const companyBranchIds = await loadCompanyBranchIds(user.company_id);
  const scope = resolveAuthorizedScope({ permissions, query: authorizationQuery, role, user, companyBranchIds });
  if (scope.error) {
    res.status(scope.status).json({ error: scope.error });
    return null;
  }

  if (requireHistory) {
    const historyAllowed = scope.type === 'self'
      ? permissions.has('history.read.self') || permissions.has('history.read.branch')
      : permissions.has('history.read.branch');
    if (!historyAllowed) {
      res.status(403).json({ error: `Missing permission: ${scope.type === 'self' ? 'history.read.self' : 'history.read.branch'}` });
      return null;
    }
  }

  let range = null;
  if (requireRange) {
    range = parseDateRange(req.query || {});
    if (range.error) {
      res.status(400).json({ error: range.error });
      return null;
    }
  }

  return { payload, permissions, range, role, scope, user };
}

async function authenticateHistory(req, res) {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }
  let payload;
  try {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
    payload = verifyAny(token);
  } catch (_error) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
  const userId = payload?.sub || payload?.id;
  if (!userId) {
    res.status(401).json({ error: 'Invalid token payload' });
    return null;
  }
  const [userResult, permissionResult] = await Promise.all([
    pool.query(USER_WITH_COMPANY_SQL, [userId]),
    pool.query('select permission from user_permissions where user_id = $1', [userId]),
  ]);
  const user = userResult.rows[0];
  if (!user) {
    res.status(401).json({ error: 'Session is no longer valid' });
    return null;
  }
  const tenantCheck = checkTenantAccess({ payload, user });
  if (!tenantCheck.ok) {
    res.status(tenantCheck.status).json(tenantCheck.body);
    return null;
  }
  const role = String(user.role || '').trim().toLowerCase();
  const permissions = effectivePermissions(role, permissionResult.rows || []);
  const requestedBranch = req.query?.branch_id || req.query?.branchId || req.query?.id || null;
  if (requestedBranch && !UUID_PATTERN.test(String(requestedBranch))) {
    res.status(400).json({ error: 'Branch ID must be a UUID' });
    return null;
  }
  if (NETWORK_ROLES.has(role) && permissions.has('history.read.branch')) {
    // Network roles: any branch of their company (Phase 1), never another's.
    const companyBranchIds = await loadCompanyBranchIds(user.company_id);
    if (requestedBranch && !companyBranchIds.includes(String(requestedBranch))) {
      res.status(403).json({ error: 'Branch history is outside the authenticated user scope' });
      return null;
    }
    return {
      payload,
      permissions,
      role,
      scope: requestedBranch
        ? { type: 'branch', branchId: String(requestedBranch), employeeId: null }
        : { type: 'global', branchId: null, employeeId: null, companyId: String(user.company_id), branchIds: companyBranchIds },
      user,
    };
  }
  if (permissions.has('history.read.branch')) {
    if (!user.branch_id) {
      res.status(403).json({ error: 'Authenticated user has no branch scope' });
      return null;
    }
    if (requestedBranch && String(requestedBranch) !== String(user.branch_id)) {
      res.status(403).json({ error: 'Branch history is outside the authenticated user scope' });
      return null;
    }
    return {
      payload,
      permissions,
      role,
      scope: { type: 'branch', branchId: String(user.branch_id), employeeId: null },
      user,
    };
  }
  if (permissions.has('history.read.self')) {
    return {
      payload,
      permissions,
      role,
      scope: { type: 'self', branchId: user.branch_id ? String(user.branch_id) : null, employeeId: String(user.id) },
      user,
    };
  }
  res.status(403).json({ error: 'Missing history permission' });
  return null;
}

/**
 * Company every statistics/history/quality query is bound to (MULTI_TENANCY
 * B2: "global" means the whole company, never the whole database). Taken from
 * the authorized scope or the DB-loaded user; fails closed when missing.
 * @param {{ scope?: { companyId?: string|null }, user?: { company_id?: string|null } }} access
 * @returns {string}
 */
function requireAccessCompanyId(access) {
  const companyId = access?.scope?.companyId || access?.user?.company_id;
  if (!companyId) {
    const error = new Error('Company scope is missing');
    error.code = 'COMPANY_SCOPE_MISSING';
    throw error;
  }
  return String(companyId);
}

function canReviewQuality(access) {
  return Boolean(
    access
    && REVIEW_ROLES.has(access.role)
    && access.scope.type !== 'self'
    && access.permissions?.has(QUALITY_REVIEW_PERMISSION),
  );
}

module.exports = {
  BRANCH_ROLES,
  NETWORK_ROLES,
  PLATFORM_ROLES,
  QUALITY_REVIEW_PERMISSION,
  SELF_ROLES,
  authenticateStatistics,
  authenticateHistory,
  canReviewQuality,
  effectivePermissions,
  parseCalendarDate,
  parseDateRange,
  requireAccessCompanyId,
  resolveAuthorizedScope,
};
