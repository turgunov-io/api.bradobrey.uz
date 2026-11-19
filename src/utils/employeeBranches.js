const { db, pool } = require('../config/postgres');
const { applyEmployeeLogoutTransaction } = require('./employeePresenceTransaction');
const { NETWORK_ROLES } = require('./employeeQualityAccess');

const isMissingRelation = (error, relation) => {
  const text = [error?.code, error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return text.includes(relation.toLowerCase()) && (text.includes('does not exist') || text.includes('not found') || text.includes('schema cache'));
};

const normalizeId = (value) => {
  const id = String(value || '').trim();
  return id || null;
};

const NETWORK_BRANCH_ROLES = Object.freeze([...NETWORK_ROLES]);

/**
 * Allow-list branch selection (pure mirror of the SQL in listEmployeeBranches).
 * Allowed = home branch(es) ∪ branches with an active access row; network
 * roles get every branch of their company. Closed branches, other companies'
 * branches and explicit deny rows (is_active = false) always win. Without a
 * `companyId` nothing is selectable (Phase 2: fail closed).
 *
 * @param {Array<{id: string, is_active?: boolean, company_id?: string}>} branches
 * @param {Array<{branch_id: string, is_active: boolean}>} accessRows
 * @param {{ homeBranchIds?: Array<string|null>, role?: string|null, companyId?: string|null }} [options]
 */
const selectEmployeeBranches = (branches = [], accessRows = [], { homeBranchIds = [], role = null, companyId = null } = {}) => {
  if (!normalizeId(companyId)) return [];
  const deniedBranchIds = new Set(
    accessRows
      .filter((row) => row?.is_active === false)
      .map((row) => String(row.branch_id))
  );
  const allowedBranchIds = new Set([
    ...homeBranchIds.map(normalizeId).filter(Boolean),
    ...accessRows.filter((row) => row?.is_active === true).map((row) => String(row.branch_id)),
  ]);
  const isNetworkRole = NETWORK_ROLES.has(role);

  return branches.filter((branch) => (
    branch?.is_active !== false
    && String(branch?.company_id || '') === String(companyId)
    && !deniedBranchIds.has(String(branch.id))
    && (isNetworkRole || allowedBranchIds.has(String(branch.id)))
  ));
};

// Phase 2: the fallback (home) branch must belong to the employee's company;
// no users row / no company -> nothing.
const loadFallbackBranch = async (fallback, employeeId) => {
  if (!fallback || !employeeId) return [];
  const legacy = await db.query(
    `select id, name, address, city, timezone
       from branches
      where id = $1 and is_active = true
        and company_id = (select company_id from users where id = $2)`,
    [fallback, employeeId],
  );
  return legacy.rows || [];
};

async function listEmployeeBranches(employeeId, fallbackBranchId = null) {
  const id = normalizeId(employeeId);
  const fallback = normalizeId(fallbackBranchId);
  if (!id) return [];

  // ALLOW-list (Phase 0.7). users.branch_id / barbers.branch_id is the home
  // branch; additional workplaces need an explicit `is_active = true` row in
  // employee_branch_access (backfilled from real work history by
  // db/postgres/employee_branch_access_allowlist_backfill.sql). Network roles
  // (role read from the DB, not the token) keep every active branch. An
  // explicit `is_active = false` row always revokes, including the home branch.
  // `fallbackBranchId` is a server-side home-branch hint from the caller.
  const result = await db.query(`
    select b.id, b.name, b.address, b.city, b.timezone
      from branches b
      left join users u on u.id = $1
      left join barbers bb on bb.id = $1
     where b.is_active = true
       -- MULTI_TENANCY Phase 1: never outside the employee's company (also
       -- for network roles); no users row / no company -> no branches.
       and b.company_id = (select company_id from users where id = $1)
       and not exists (
         select 1
           from employee_branch_access a
          where a.employee_id = $1
            and a.branch_id = b.id
            and a.is_active = false
       )
       and (
         u.role = any($2::text[])
         or b.id = u.branch_id
         or b.id = bb.branch_id
         or b.id = $3::uuid
         or exists (
           select 1
             from employee_branch_access grant_row
            where grant_row.employee_id = $1
              and grant_row.branch_id = b.id
              and grant_row.is_active = true
         )
       )
     order by b.name asc, b.id asc
  `, [id, NETWORK_BRANCH_ROLES, fallback]).catch((error) => ({ rows: [], error }));

  if (result.error) {
    if (!isMissingRelation(result.error, 'employee_branch_access')) throw result.error;
    // Pre-migration schema: only the home branch is known to be allowed.
    return loadFallbackBranch(fallback, id);
  }

  // No fallback when the list is empty: an empty result means every candidate
  // branch is closed or explicitly denied, and must stay denied.
  return result.rows || [];
}

async function resolveEmployeeBranch({ employeeId, requestedBranchId, fallbackBranchId }) {
  const branches = await listEmployeeBranches(employeeId, fallbackBranchId);
  const requested = normalizeId(requestedBranchId);
  if (!requested && branches.length > 1) {
    const error = new Error('Branch selection is required');
    error.code = 'BRANCH_SELECTION_REQUIRED';
    error.branches = branches;
    throw error;
  }

  const branchId = requested || normalizeId(branches[0]?.id) || normalizeId(fallbackBranchId);
  if (!branchId || !branches.some((branch) => String(branch.id) === branchId)) {
    const error = new Error('Employee is not allowed to work in the selected branch');
    error.code = 'BRANCH_ACCESS_DENIED';
    throw error;
  }
  return { branchId, branches };
}

async function setActiveEmployeeBranch({ employeeId, branchId, isOnShift, sessionId = null, sessionExpiresAt = null }) {
  try {
    await db.query(`
    insert into employee_active_branches (
      employee_id, branch_id, is_on_shift, session_id, session_expires_at, selected_at, updated_at
    )
    values ($1, $2, $3, $4, $5, now(), now())
    on conflict (employee_id) do update set
      branch_id = excluded.branch_id,
      is_on_shift = excluded.is_on_shift,
      session_id = case when $4 is null then employee_active_branches.session_id else excluded.session_id end,
      session_expires_at = case when $4 is null then employee_active_branches.session_expires_at else excluded.session_expires_at end,
      selected_at = case when employee_active_branches.branch_id is distinct from excluded.branch_id then now() else employee_active_branches.selected_at end,
      updated_at = now()
    `, [normalizeId(employeeId), normalizeId(branchId), Boolean(isOnShift), normalizeId(sessionId), sessionExpiresAt]);
  } catch (error) {
    if (sessionId || !isMissingRelation(error, 'employee_active_branches')) throw error;
  }
}

async function getActiveEmployeeBranch(employeeId) {
  try {
    const result = await db.query('select employee_id, branch_id, is_on_shift, session_id, session_expires_at, selected_at, updated_at from employee_active_branches where employee_id = $1', [normalizeId(employeeId)]);
    return result.rows?.[0] || null;
  } catch (error) {
    if (isMissingRelation(error, 'employee_active_branches')) return null;
    throw error;
  }
}

async function touchActiveEmployeeBranch({ employeeId, branchId }) {
  try {
    const result = await db.query(`
      update employee_active_branches
         set updated_at = now()
       where employee_id = $1
         and branch_id = $2
         and session_id is not null
         and session_expires_at > now()
       returning employee_id, branch_id, is_on_shift, updated_at
    `, [normalizeId(employeeId), normalizeId(branchId)]);
    return result.rows?.[0] || null;
  } catch (error) {
    if (isMissingRelation(error, 'employee_active_branches')) return null;
    throw error;
  }
}

async function logoutEmployeePresence(employeeId) {
  const normalizedEmployeeId = normalizeId(employeeId);
  if (!normalizedEmployeeId) return { barber: null, activeBranchId: null };

  const client = await pool.connect();
  try {
    return await applyEmployeeLogoutTransaction(client, normalizedEmployeeId);
  } finally {
    client.release();
  }
}

async function employeeCanUseBranch(employeeId, branchId, fallbackBranchId = null) {
  const branches = await listEmployeeBranches(employeeId, fallbackBranchId);
  return branches.some((branch) => String(branch.id) === String(branchId));
}

module.exports = {
  employeeCanUseBranch,
  listEmployeeBranches,
  getActiveEmployeeBranch,
  applyEmployeeLogoutTransaction,
  logoutEmployeePresence,
  listEmployeeBranches,
  normalizeId,
  resolveEmployeeBranch,
  selectEmployeeBranches,
  setActiveEmployeeBranch,
  touchActiveEmployeeBranch,
};
