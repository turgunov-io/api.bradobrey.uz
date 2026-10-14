const { db, pool } = require('../config/postgres');
const { applyEmployeeLogoutTransaction } = require('./employeePresenceTransaction');

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

const selectEmployeeBranches = (branches = [], accessRows = []) => {
  const deniedBranchIds = new Set(
    accessRows
      .filter((row) => row?.is_active === false)
      .map((row) => String(row.branch_id))
  );

  return branches.filter((branch) => (
    branch?.is_active !== false && !deniedBranchIds.has(String(branch.id))
  ));
};

async function listEmployeeBranches(employeeId, fallbackBranchId = null) {
  const id = normalizeId(employeeId);
  const fallback = normalizeId(fallbackBranchId);
  if (!id) return [];

  // A barber's users.branch_id is the permanent/home branch, not today's
  // workplace. Active branches are therefore selectable by default. The
  // access table is kept as an explicit deny list (`is_active = false`) so
  // administrators can still revoke a specific branch without turning the
  // legacy backfilled home-branch row into a hidden allow-list barrier.
  const result = await db.query(`
    select b.id, b.name, b.address, b.city, b.timezone
      from branches b
     where b.is_active = true
       and not exists (
         select 1
           from employee_branch_access a
          where a.employee_id = $1
            and a.branch_id = b.id
            and a.is_active = false
       )
     order by b.name asc, b.id asc
  `, [id]).catch((error) => ({ rows: [], error }));

  if (result.error) {
    if (!isMissingRelation(result.error, 'employee_branch_access')) throw result.error;
    if (!fallback) return [];
    const legacy = await db.query('select id, name, address, city, timezone from branches where id = $1 and is_active = true', [fallback]);
    return legacy.rows || [];
  }

  const rows = result.rows || [];
  if (!rows.length && fallback) {
    const legacy = await db.query('select id, name, address, city, timezone from branches where id = $1 and is_active = true', [fallback]);
    return legacy.rows || [];
  }
  return rows;
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

async function setActiveEmployeeBranch({ employeeId, branchId, isOnShift }) {
  try {
    await db.query(`
    insert into employee_active_branches (employee_id, branch_id, is_on_shift, selected_at, updated_at)
    values ($1, $2, $3, now(), now())
    on conflict (employee_id) do update set
      branch_id = excluded.branch_id,
      is_on_shift = excluded.is_on_shift,
      selected_at = case when employee_active_branches.branch_id is distinct from excluded.branch_id then now() else employee_active_branches.selected_at end,
      updated_at = now()
    `, [normalizeId(employeeId), normalizeId(branchId), Boolean(isOnShift)]);
  } catch (error) {
    if (!isMissingRelation(error, 'employee_active_branches')) throw error;
  }
}

async function getActiveEmployeeBranch(employeeId) {
  try {
    const result = await db.query('select employee_id, branch_id, is_on_shift, selected_at, updated_at from employee_active_branches where employee_id = $1', [normalizeId(employeeId)]);
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
         and is_on_shift = true
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
