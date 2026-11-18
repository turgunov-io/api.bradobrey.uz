// Authorization for the dashboard resource routers that used to be open to
// anonymous callers (audit C2): branches, services, service categories,
// warehouse, promo codes and finance.
//   (callers: routers/branches.js, services.js, serviceCategories.js,
//    warehouse.js, promocode.js, finance.js)
//
//   authenticated()            any valid token whose user still exists
//                              (dashboard, barber and merchant accounts);
//   requireStaff({ anyOf })    a dashboard role (network or branch) holding at
//                              least one of the listed permissions;
//   requireSuperuser()         admin_network / admin only.
//
// Role and permissions are read from the database, not the token, so
// demotions apply immediately. Session revocation (logout, expired jti) and
// archived accounts are rejected earlier by the global enforceEmployeeAccess
// middleware, which runs before these routers whenever a token is present. Permissions follow the dashboard model in
// utils/employeeQualityAccess.js: admins without per-user rows get the full
// preset, explicit rows narrow it.
const jwt = require('jsonwebtoken');

const { loadActorFromDb } = require('./employeeManagement');
const { BRANCH_ROLES, NETWORK_ROLES, effectivePermissions } = require('../utils/employeeQualityAccess');

const STAFF_ROLES = new Set([...NETWORK_ROLES, ...BRANCH_ROLES]);
const SUPERUSER_ROLES = new Set(['admin_network', 'admin']);

// users.id is a uuid column; other token subjects (marketplace clients) are
// rejected before they reach the database and raise 22P02.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getBearerToken(req) {
  const header = String(req.headers?.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function createStaffAccessGuard({ loadActor = loadActorFromDb, secret } = {}) {
  const deny = (res, status, error) => {
    res.status(status).json({ error });
    return null;
  };

  // Resolves the caller, or answers the request itself and returns null.
  async function resolveActor(req, res) {
    const token = getBearerToken(req);
    if (!token) return deny(res, 401, 'Authorization token is required');

    let payload;
    try {
      const jwtSecret = secret || process.env.JWT_SECRET;
      if (!jwtSecret) throw new Error('JWT_SECRET is not configured');
      payload = jwt.verify(token, jwtSecret);
    } catch (_error) {
      return deny(res, 401, 'Invalid or expired token');
    }

    const userId = String(payload?.sub || payload?.id || '');
    if (!UUID_PATTERN.test(userId)) return deny(res, 401, 'Invalid token payload');

    try {
      const actor = await loadActor(userId);
      if (!actor?.user) return deny(res, 401, 'Session is no longer valid');

      const role = String(actor.user.role || '').trim().toLowerCase();
      const permissions = effectivePermissions(
        role,
        (actor.permissions || []).map((permission) => ({ permission })),
      );
      return { actor: actor.user, permissions, role };
    } catch (error) {
      console.error('[staff-access] authorization failed:', error?.code || error?.message);
      return deny(res, 500, 'Failed to authorize request');
    }
  }

  function guard(check) {
    return async function staffAccess(req, res, next) {
      const context = await resolveActor(req, res);
      if (!context) return;

      const problem = check(context);
      if (problem) {
        deny(res, 403, problem);
        return;
      }

      req.staffAccess = context;
      next();
    };
  }

  const authenticated = () => guard(() => null);

  function requireStaff({ anyOf = [] } = {}) {
    return guard(({ role, permissions }) => {
      if (!STAFF_ROLES.has(role)) return 'Not allowed for this role';
      if (anyOf.length && !anyOf.some((permission) => permissions.has(permission))) {
        return `Missing permission: ${anyOf.join(' or ')}`;
      }
      return null;
    });
  }

  const requireSuperuser = () => guard(({ role }) => (
    SUPERUSER_ROLES.has(role) ? null : 'Only network administrators can perform this action'
  ));

  return { authenticated, requireStaff, requireSuperuser };
}

const staffAccess = createStaffAccessGuard();

module.exports = {
  STAFF_ROLES,
  createStaffAccessGuard,
  staffAccess,
};
