const { db } = require('../config/postgres');

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

async function listEmployeeBranches(employeeId, fallbackBranchId = null) {
  const id = normalizeId(employeeId);
  const fallback = normalizeId(fallbackBranchId);
  if (!id) return [];

  const result = await db.query(`
    select b.id, b.name, b.address, b.city, b.timezone
      from employee_branch_access a
      join branches b on b.id = a.branch_id
     where a.employee_id = $1 and a.is_active = true and b.is_active = true
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

async function employeeCanUseBranch(employeeId, branchId, fallbackBranchId = null) {
  const branches = await listEmployeeBranches(employeeId, fallbackBranchId);
  return branches.some((branch) => String(branch.id) === String(branchId));
}

module.exports = {
  employeeCanUseBranch,
  listEmployeeBranches,
  getActiveEmployeeBranch,
  listEmployeeBranches,
  normalizeId,
  resolveEmployeeBranch,
  setActiveEmployeeBranch,
};
