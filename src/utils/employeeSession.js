const { nextZonedDayStartIso } = require('./timezone');

function getEmployeeTokenTtlSeconds(now = new Date(), configuredTtl = process.env.JWT_EXPIRES_IN || '12h') {
  const configuredSeconds = typeof configuredTtl === 'number'
    ? configuredTtl
    : (() => {
      const match = String(configuredTtl).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)?$/i);
      if (!match) return Number.NaN;
      const amount = Number(match[1]);
      const unit = (match[2] || 'ms').toLowerCase();
      const multiplier = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31557600 }[unit];
      return amount * multiplier;
    })();
  const midnightSeconds = (Date.parse(nextZonedDayStartIso(now)) - now.getTime()) / 1000;
  if (!Number.isFinite(configuredSeconds) || configuredSeconds <= 0) return null;
  return Math.max(1, Math.floor(Math.min(configuredSeconds, midnightSeconds)));
}

function getEmployeeSessionExpiry(tokenExpiresAtSeconds, now = new Date(), existingExpiry = null) {
  const tokenExpiry = Number(tokenExpiresAtSeconds) * 1000;
  if (!Number.isFinite(tokenExpiry) || tokenExpiry <= now.getTime()) return null;

  const midnightExpiry = Date.parse(nextZonedDayStartIso(now));
  const priorExpiry = existingExpiry ? Date.parse(existingExpiry) : Number.POSITIVE_INFINITY;
  const expiry = Math.min(tokenExpiry, midnightExpiry, priorExpiry);
  return Number.isFinite(expiry) && expiry > now.getTime()
    ? new Date(expiry).toISOString()
    : null;
}

async function validatePersistedEmployeeSession({ employeeId, branchId, sessionId, role }) {
  if (!employeeId || !branchId || !sessionId) return { valid: false, reason: 'invalid' };

  const { db } = require('../config/postgres');
  const result = await db.query(`
    select eab.session_id, eab.session_expires_at,
           (eab.session_expires_at <= now()) as is_expired, u.role,
           b.is_archived, branch.is_active as branch_is_active,
           exists (
             select 1 from employee_branch_access access
              where access.employee_id = eab.employee_id
                and access.branch_id = eab.branch_id
                and access.is_active = false
           ) as branch_access_revoked
      from employee_active_branches eab
      join users u on u.id = eab.employee_id
      left join barbers b on b.id = eab.employee_id
      join branches branch on branch.id = eab.branch_id
     where eab.employee_id = $1 and eab.branch_id = $2
     limit 1
  `, [employeeId, branchId]);

  const session = result.rows?.[0];
  return evaluateEmployeeSession(session, { sessionId, role });
}

function evaluateEmployeeSession(session, { sessionId, role }) {
  if (!session || String(session.session_id || '') !== String(sessionId)) {
    return { valid: false, reason: 'revoked' };
  }
  if (!session.session_expires_at || session.is_expired === true) {
    return { valid: false, reason: 'expired' };
  }
  if (session.role !== role || session.is_archived === true) {
    return { valid: false, reason: 'account_blocked' };
  }
  if (session.branch_is_active !== true || session.branch_access_revoked === true) {
    return { valid: false, reason: 'branch_access_revoked' };
  }
  return { valid: true };
}

module.exports = {
  evaluateEmployeeSession,
  getEmployeeSessionExpiry,
  getEmployeeTokenTtlSeconds,
  validatePersistedEmployeeSession,
};
