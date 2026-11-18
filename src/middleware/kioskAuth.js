// Kiosk device authentication for kiosk data routes (MULTI_TENANCY 0.1 / 0.3).
//   (callers: routers/kiosk.js, routers/monitor.js)
//
// Kiosks send the device token they got from POST /api/kiosk/register in the
// `X-Kiosk-Token` header. A valid token sets req.kiosk = { id, branchId } and
// pins the request to that branch: any branch_id in params/body/query that
// differs answers 403; a POST body without branch_id gets the kiosk branch.
//
// Compatibility (deployed kiosk apps do not send the header yet):
//   - a present but unknown token is always 401;
//   - no token + KIOSK_AUTH_ENFORCE unset/false: legacy behaviour, one warning
//     per route per process;
//   - no token + KIOSK_AUTH_ENFORCE=true: 401, unless the route allows a bearer
//     JWT and a valid one is sent: an active employee (DB-loaded, branch
//     checked against the allowed branches) or, on routes that opt in, a
//     marketplace client token. Any other bearer is 403.
const jwt = require('jsonwebtoken');

const KIOSK_TOKEN_HEADER = 'x-kiosk-token';
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

const isKioskAuthEnforced = (env = process.env) => TRUE_VALUES.has(String(env.KIOSK_AUTH_ENFORCE || '').trim().toLowerCase());

const bearerToken = (req) => {
  const header = String(req.headers?.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

function defaultVerifyBearer(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    return jwt.verify(token, secret);
  } catch (_error) {
    return null;
  }
}

const defaultAuthenticate = (token) => require('../services/kioskRegistration').kioskRegistry.authenticateDevice(token);
// DB helpers load lazily (config/postgres needs database env at require time).
const defaultLoadStaff = (userId) => require('./employeeAccess').loadEmployeeAccessState(userId);
const defaultIsArchived = (barber) => require('./employeeAccess').isArchivedEmployee(barber);
const defaultResolveScope = (user) => require('../utils/adminAuth').resolveAllowedBranchIds(user);

const MARKETPLACE_ROLE = 'marketplace';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sameId = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

const isPresent = (value) => value !== undefined && value !== null && String(value).trim() !== '';

function requestedBranchIds(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  return [req.params?.branch_id, body.branch_id, req.query?.branch_id].filter(isPresent);
}

function createKioskAuth({
  authenticate = defaultAuthenticate,
  verifyBearer = defaultVerifyBearer,
  loadStaff = defaultLoadStaff,
  isArchived = defaultIsArchived,
  resolveScope = defaultResolveScope,
  env = process.env,
  warn = console.warn,
  logError = console.error,
} = {}) {
  const warnedRoutes = new Set();

  function warnLegacyOnce(req) {
    const key = `${req.method} ${req.baseUrl || ''}${req.route?.path || req.path || ''}`;
    if (warnedRoutes.has(key)) return;
    warnedRoutes.add(key);
    warn(`[kiosk-auth] ${key} called without X-Kiosk-Token; allowed because KIOSK_AUTH_ENFORCE is off`);
  }

  async function withKioskToken(token, req, res, next) {
    let kiosk;
    try {
      kiosk = await authenticate(token);
    } catch (error) {
      logError('[kiosk-auth] token lookup failed:', error?.code || error?.message);
      return res.status(500).json({ error: 'Failed to authenticate kiosk' });
    }
    if (!kiosk) return res.status(401).json({ error: 'Kiosk device token is invalid', code: 'KIOSK_TOKEN_INVALID' });

    if (requestedBranchIds(req).some((branchId) => !sameId(branchId, kiosk.branchId))) {
      return res.status(403).json({ error: 'Branch does not match the authenticated kiosk', code: 'KIOSK_BRANCH_MISMATCH' });
    }

    req.kiosk = { id: kiosk.id, branchId: kiosk.branchId };
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && !isPresent(req.body.branch_id)) {
      req.body.branch_id = kiosk.branchId;
    }
    return next();
  }

  const forbidden = (res, error) => res.status(403).json({ error, code: 'KIOSK_BEARER_FORBIDDEN' });

  // Enforce mode, bearer JWT instead of a kiosk token. Accepted only for
  //   (a) an existing, non-archived employee loaded from the DB (role from the
  //       DB, never the token): every requested branch must be in the
  //       employee's allowed branches (network roles: unrestricted); the scope
  //       is exposed as req.kioskStaff for handlers without a branch_id;
  //   (b) a marketplace client token, only where the route allows it.
  async function withBearer(payload, req, res, next, allowMarketplace) {
    if (payload?.role === MARKETPLACE_ROLE) {
      if (allowMarketplace(req)) return next();
      return forbidden(res, 'Marketplace tokens cannot use this kiosk route');
    }

    const userId = String(payload?.sub || payload?.id || '');
    if (!UUID_PATTERN.test(userId)) return forbidden(res, 'Only employees can use kiosk routes with a bearer token');

    let staff;
    try {
      const state = await loadStaff(userId);
      if (!state?.user || isArchived(state.barber)) {
        return forbidden(res, 'Only active employees can use kiosk routes with a bearer token');
      }
      const role = String(state.user.role || '').trim().toLowerCase();
      const branchScope = await resolveScope({ ...state.user, role });
      staff = { id: state.user.id, role, branchScope };
    } catch (error) {
      logError('[kiosk-auth] staff lookup failed:', error?.code || error?.message);
      return res.status(500).json({ error: 'Failed to authenticate kiosk request' });
    }

    if (staff.branchScope !== null) {
      const allowed = staff.branchScope.map(String);
      if (requestedBranchIds(req).some((branchId) => !allowed.some((id) => sameId(id, branchId)))) {
        return res.status(403).json({ error: 'Employee is not allowed to use this branch', code: 'KIOSK_BRANCH_FORBIDDEN' });
      }
    }
    req.kioskStaff = staff;
    return next();
  }

  // allowBearer: a bearer JWT may satisfy enforce mode (see withBearer).
  // allowMarketplace(req): whether a marketplace client token is accepted.
  return function kioskAuth({ allowBearer = false, allowMarketplace = () => false } = {}) {
    return async function kioskAuthMiddleware(req, res, next) {
      const token = String(req.headers?.[KIOSK_TOKEN_HEADER] || '').trim();
      if (token) return withKioskToken(token, req, res, next);

      const bearer = allowBearer ? bearerToken(req) : '';
      if (!isKioskAuthEnforced(env)) {
        if (!bearer) warnLegacyOnce(req);
        return next();
      }
      const payload = bearer ? verifyBearer(bearer) : null;
      if (payload) return withBearer(payload, req, res, next, allowMarketplace);
      return res.status(401).json({ error: 'Kiosk device token is required', code: 'KIOSK_TOKEN_REQUIRED' });
    };
  };
}

const kioskAuth = createKioskAuth();

module.exports = {
  KIOSK_TOKEN_HEADER,
  createKioskAuth,
  isKioskAuthEnforced,
  kioskAuth,
};
