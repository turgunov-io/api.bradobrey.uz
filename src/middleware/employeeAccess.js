const jwt = require('jsonwebtoken');

const { db } = require('../config/postgres');

const EMPLOYEE_ACCESS_ROLES = new Set([
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
      .select('id, branch_id, is_active, is_authorized, is_on_shift')
      .eq('id', userId)
      .maybeSingle(),
  ]);

  if (userError) throw new Error(userError.message);
  if (barberError) throw new Error(barberError.message);

  return { barber: barber || null, user: user || null };
}

function isArchivedEmployee(barber) {
  return Boolean(
    barber
    && (barber.is_active === false || barber.is_authorized === false)
  );
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

    req.employeeAccess = { barber, payload, user };
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
