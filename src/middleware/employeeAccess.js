const jwt = require('jsonwebtoken');

const { db } = require('../config/postgres');
const { validatePersistedEmployeeSession } = require('../utils/employeeSession');

const EMPLOYEE_ACCESS_ROLES = new Set([
  'admin_network',
  'admin_branch',
  'admin',
  'manager',
  'barber',
  'super-barber',
  'super-manager',
]);

function getBearerToken(req) {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

async function loadEmployeeAccessState(userId) {
  if (!userId) {
    return { barber: null, user: null };
  }

  const [{ data: user, error: userError }, { data: barber, error: barberError }] = await Promise.all([
    db
      .from('users')
      .select('id, login, role, branch_id')
      .eq('id', userId)
      .maybeSingle(),
    db
      .from('barbers')
      .select('id, branch_id, is_active, is_authorized, is_archived, is_on_shift')
      .eq('id', userId)
      .maybeSingle(),
  ]);

  if (userError) throw new Error(userError.message);
  if (barberError) throw new Error(barberError.message);

  return { barber: barber || null, user: user || null };
}

function isArchivedEmployee(barber) {
  // `is_active` is the operational availability flag (for example, a break
  // sets it to false). `is_authorized` predates employee archiving and is
  // still used by existing integrations. Neither one must revoke a login.
  return barber?.is_archived === true;
}

async function enforceEmployeeAccess(req, res, next) {
  const token = getBearerToken(req);

  if (!token) {
    next();
    return;
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (_error) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const role = String(payload?.role || '').trim();
  if (!EMPLOYEE_ACCESS_ROLES.has(role)) {
    next();
    return;
  }

  const userId = payload?.sub || payload?.id;

  try {
    const { barber, user } = await loadEmployeeAccessState(userId);

    if (!user) {
      res.status(401).json({ error: 'Session is no longer valid' });
      return;
    }

    if (isArchivedEmployee(barber)) {
      res.status(403).json({ error: 'Employee access has been revoked' });
      return;
    }

    if (['barber', 'super-barber', 'manager', 'super-manager'].includes(role)) {
      let session;
      try {
        session = await validatePersistedEmployeeSession({
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
    next();
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to validate employee access' });
  }
}

module.exports = {
  EMPLOYEE_ACCESS_ROLES,
  enforceEmployeeAccess,
  isArchivedEmployee,
  loadEmployeeAccessState,
};
