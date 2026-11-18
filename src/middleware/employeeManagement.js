// Authorization for the dashboard's employee-management routes
// (/api/barbers list, register, update, archive/restore, delete).
//
// Mirrors the dashboard permission model (dash/shared/auth/employees.ts):
//   (callers: routers/barbers.js)
//   - `employees.read|create|update|delete` permissions gate each action;
//   - admin_network/admin with no per-user permission rows are superusers;
//   - branch roles (admin_branch, manager) act only inside their own branch;
//   - nobody but a superuser can assign a role at or above their own, modify
//     an employee at or above their own role, or grant permissions they lack;
//   - only admin_network may touch an admin_network account.
//
// `authorize(action)` runs before multer (token, role, permission, target
// checks) so anonymous callers cannot upload; `checkPayload` runs after body
// parsing to validate branch, role and permissions in the submitted form.
//
// MULTI_TENANCY Phase 1: everything is limited to the actor's company
// (users.company_id): targets of another company are "not found", a submitted
// branch must belong to the company, and the directory is filtered by
// req.employeeManagement.companyId. Suspended companies are rejected.
const { getBearerToken, verifyAny } = require('../utils/authToken');
const { checkTenantAccess, companyRepo } = require('../utils/tenant');

const { pool } = require('../config/postgres');
const { BRANCH_ROLES, NETWORK_ROLES, effectivePermissions } = require('../utils/employeeQualityAccess');

const ACTION_PERMISSIONS = {
  read: 'employees.read',
  create: 'employees.create',
  update: 'employees.update',
  delete: 'employees.delete',
};

const ROLE_RANK = {
  barber: 1,
  'super-barber': 2,
  manager: 3,
  admin_branch: 3,
  'super-manager': 4,
  admin: 5,
  admin_network: 6,
};

const SUPERUSER_ROLES = new Set(['admin_network', 'admin']);

// The employee directory (GET /api/barbers) feeds pickers on finance, verifix,
// penalties, statistics, history and clients pages, so any dashboard user may
// read it (still branch-scoped). Writes always need the exact employees.* permission.
const DIRECTORY_READ_PERMISSIONS = ['employees.read', 'dashboard.access'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const normalizeRole = (value) => String(value || '').trim().toLowerCase();
const normalizeId = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

// Same parsing as models/barbers.js normalizePermissions, so the check sees
// exactly what syncUserPermissions will store (arrays or comma-separated form fields).
const normalizeRequestedPermissions = (value) => {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return [...new Set(
    items
      .flatMap((item) => (typeof item === 'string' && item.includes(',') ? item.split(',') : [item]))
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )];
};

const rankOf = (role) => ROLE_RANK[normalizeRole(role)] || 0;

// users row + its company status (for checkTenantAccess) and permissions.
async function loadActorFromDb(userId) {
  const [userResult, permissionResult] = await Promise.all([
    pool.query(
      `select u.id, u.role, u.branch_id, u.company_id, c.status as company_status
         from users u
         left join companies c on c.id = u.company_id
        where u.id = $1
        limit 1`,
      [userId],
    ),
    pool.query('select permission from user_permissions where user_id = $1', [userId]),
  ]);
  const user = userResult.rows[0];
  if (!user) return null;
  return { user, permissions: permissionResult.rows.map((row) => row.permission) };
}

async function loadTargetFromDb(id) {
  const result = await pool.query(
    `select u.id, u.role, coalesce(b.branch_id, u.branch_id) as branch_id, u.company_id
       from users u
       left join barbers b on b.id = u.id
      where u.id = $1
      limit 1`,
    [id],
  );
  return result.rows[0] || null;
}

function createEmployeeManagementGuard({
  loadActor = loadActorFromDb,
  loadTarget = loadTargetFromDb,
  loadBranch = (id) => companyRepo.findBranch(id),
  secret,
  validateId = true,
} = {}) {
  const deny = (res, status, error) => res.status(status).json({ error });

  // Superusers bypass the rank rule except for admin_network accounts, which
  // only another admin_network may create or change.
  const canAssignRole = (actorRole, role) => {
    if (normalizeRole(role) === 'admin_network') return actorRole === 'admin_network';
    if (SUPERUSER_ROLES.has(actorRole)) return true;
    return rankOf(role) < rankOf(actorRole);
  };

  function authorize(action) {
    const permission = ACTION_PERMISSIONS[action];
    if (!permission) throw new Error(`Unknown employee management action: ${action}`);

    return async function authorizeEmployeeManagement(req, res, next) {
      const token = getBearerToken(req);
      if (!token) return deny(res, 401, 'Authorization token is required');

      let payload;
      try {
        const jwtSecret = secret || process.env.JWT_SECRET;
        if (!jwtSecret) throw new Error('JWT_SECRET is not configured');
        payload = verifyAny(token, { secret: jwtSecret });
      } catch (_error) {
        return deny(res, 401, 'Invalid or expired token');
      }

      const userId = payload?.sub || payload?.id;
      if (!userId) return deny(res, 401, 'Invalid token payload');

      try {
        const actor = await loadActor(String(userId));
        if (!actor?.user) return deny(res, 401, 'Session is no longer valid');
        const tenantCheck = checkTenantAccess({ payload, user: actor.user });
        if (!tenantCheck.ok) return res.status(tenantCheck.status).json(tenantCheck.body);
        const companyId = tenantCheck.tenant.companyId;

        // Role comes from the database, not the token, so demotions apply immediately.
        const role = normalizeRole(actor.user.role);
        const isBranchRole = BRANCH_ROLES.has(role);
        if (!NETWORK_ROLES.has(role) && !isBranchRole) {
          return deny(res, 403, 'Employee management is not available for this role');
        }

        const permissions = effectivePermissions(
          role,
          (actor.permissions || []).map((item) => ({ permission: item })),
        );
        const allowed = action === 'read'
          ? DIRECTORY_READ_PERMISSIONS.some((item) => permissions.has(item))
          : permissions.has(permission);
        if (!allowed) return deny(res, 403, `Missing permission: ${permission}`);

        const actorBranchId = normalizeId(actor.user.branch_id);
        if (isBranchRole && !actorBranchId) return deny(res, 403, 'Authenticated user has no branch scope');

        let target = null;
        const targetId = normalizeId(req.params?.id);
        if (targetId) {
          // users.id is a uuid column; a malformed id would raise 22P02 (500).
          if (validateId && !UUID_PATTERN.test(targetId)) return deny(res, 404, 'Employee not found');
          target = await loadTarget(targetId);
          if (!target) return deny(res, 404, 'Employee not found');
          // Another company's employee does not exist for this caller.
          if (!companyId || String(target.company_id || '') !== String(companyId)) {
            return deny(res, 404, 'Employee not found');
          }
          // Accounts outside the employee hierarchy (merchant, partner, …) are
          // not managed here; rank 0 would otherwise make them editable by anyone.
          if (!ROLE_RANK[normalizeRole(target.role)]) {
            return deny(res, 403, 'Not allowed to manage this account');
          }
          if (action === 'delete' && String(target.id) === String(actor.user.id)) {
            return deny(res, 403, 'You cannot archive your own account');
          }
          if (isBranchRole && normalizeId(target.branch_id) !== actorBranchId) {
            return deny(res, 403, 'Employee is outside the authenticated user scope');
          }
          if (!canAssignRole(role, target.role)) {
            return deny(res, 403, 'Not allowed to manage an employee with this role');
          }
        }

        let branchId = null;
        if (action === 'read') {
          const requestedBranchId = normalizeId(req.query?.branch_id);
          if (isBranchRole) {
            if (requestedBranchId && requestedBranchId !== actorBranchId) {
              return deny(res, 403, 'Branch is outside the authenticated user scope');
            }
            branchId = actorBranchId;
          }
        }

        req.tenant = tenantCheck.tenant;
        req.employeeManagement = {
          action,
          actor: actor.user,
          branchId,
          companyId,
          isBranchRole,
          permissions,
          role,
          target,
        };
        return next();
      } catch (error) {
        console.error('[employee-management] authorization failed:', error?.code || error?.message);
        return deny(res, 500, 'Failed to authorize request');
      }
    };
  }

  async function checkPayload(req, res, next) {
    const context = req.employeeManagement;
    if (!context) return deny(res, 500, 'Employee management authorization missing');

    const body = req.body || {};
    const { role: actorRole, isBranchRole, permissions } = context;
    const actorBranchId = normalizeId(context.actor.branch_id);

    if (isBranchRole && body.branch_id !== undefined && normalizeId(body.branch_id) !== actorBranchId) {
      return deny(res, 403, 'Branch is outside the authenticated user scope');
    }

    // Network roles may pick any branch, but only of their own company.
    const requestedBranchId = normalizeId(body.branch_id);
    if (!isBranchRole && requestedBranchId) {
      if (validateId && !UUID_PATTERN.test(requestedBranchId)) return deny(res, 400, 'branch_id is invalid');
      let branch;
      try {
        branch = await loadBranch(requestedBranchId);
      } catch (error) {
        console.error('[employee-management] branch lookup failed:', error?.code || error?.message);
        return deny(res, 500, 'Failed to authorize request');
      }
      if (!branch || !context.companyId || String(branch.company_id) !== String(context.companyId)) {
        return deny(res, 403, 'Branch is outside the authenticated user scope');
      }
    }

    if (body.role !== undefined && !canAssignRole(actorRole, body.role)) {
      return deny(res, 403, 'Not allowed to assign this role');
    }

    // Superusers without per-user rows already hold the full preset, so this
    // only bites accounts whose permissions were deliberately narrowed.
    if (body.permissions !== undefined) {
      const missing = normalizeRequestedPermissions(body.permissions).filter((item) => !permissions.has(item));
      if (missing.length) return deny(res, 403, `Cannot grant permissions you do not hold: ${missing.join(', ')}`);
    }

    return next();
  }

  return { authorize, checkPayload };
}

const employeeManagement = createEmployeeManagementGuard();

module.exports = {
  ACTION_PERMISSIONS,
  createEmployeeManagementGuard,
  employeeManagement,
  loadActorFromDb,
};
