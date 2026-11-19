const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.PGDATABASE ||= 'phase0-barber-branch-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'phase0-barber-branch-tests';

const { db } = require('../src/config/postgres');
const {
  listEmployeeBranches,
  resolveEmployeeBranch,
  selectEmployeeBranches,
} = require('../src/utils/employeeBranches');

// selectEmployeeBranches fails closed without a company (Phase 2).
const COMPANY = 'company-1';
const home = { id: 'branch-home', name: 'Home', is_active: true, company_id: COMPANY };
const granted = { id: 'branch-granted', name: 'Granted', is_active: true, company_id: COMPANY };
const other = { id: 'branch-other', name: 'Other', is_active: true, company_id: COMPANY };
const closed = { id: 'branch-closed', name: 'Closed', is_active: false, company_id: COMPANY };
const ALL = [home, granted, other, closed];

// ---- pure allow-list semantics ----

test('allow-list: home branch plus explicitly granted branches, nothing else', () => {
  const access = [{ employee_id: 'e1', branch_id: granted.id, is_active: true }];
  const ids = selectEmployeeBranches(ALL, access, { homeBranchIds: [home.id], role: 'barber', companyId: COMPANY })
    .map((branch) => branch.id);
  assert.deepEqual(ids, [home.id, granted.id]);
});

test('allow-list: an employee with no grants only sees the home branch', () => {
  const ids = selectEmployeeBranches(ALL, [], { homeBranchIds: [home.id], role: 'barber', companyId: COMPANY })
    .map((branch) => branch.id);
  assert.deepEqual(ids, [home.id]);
});

test('allow-list: an explicit deny row overrides home and grants', () => {
  const access = [
    { employee_id: 'e1', branch_id: home.id, is_active: false },
    { employee_id: 'e1', branch_id: granted.id, is_active: true },
  ];
  const ids = selectEmployeeBranches(ALL, access, { homeBranchIds: [home.id], role: 'super-barber', companyId: COMPANY })
    .map((branch) => branch.id);
  assert.deepEqual(ids, [granted.id]);
});

test('allow-list: network roles keep every active (non-denied) branch', () => {
  for (const role of ['admin_network', 'admin', 'super-manager']) {
    const ids = selectEmployeeBranches(ALL, [], { homeBranchIds: [home.id], role, companyId: COMPANY })
      .map((branch) => branch.id);
    assert.deepEqual(ids, [home.id, granted.id, other.id], role);
  }
});

test('allow-list: branch-scoped manager roles are not treated as network roles', () => {
  const ids = selectEmployeeBranches(ALL, [], { homeBranchIds: [home.id], role: 'manager', companyId: COMPANY })
    .map((branch) => branch.id);
  assert.deepEqual(ids, [home.id]);
});

test('allow-list: closed branches are never selectable, even when granted', () => {
  const access = [{ employee_id: 'e1', branch_id: closed.id, is_active: true }];
  const ids = selectEmployeeBranches(ALL, access, { homeBranchIds: [closed.id], role: 'barber', companyId: COMPANY })
    .map((branch) => branch.id);
  assert.deepEqual(ids, []);
});

// ---- DB-backed listEmployeeBranches ----

function installQueryMock(handler) {
  const original = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return handler(String(sql), params);
  };
  return { calls, restore() { db.query = original; } };
}

test('listEmployeeBranches queries an allow-list (home | active grant | network role), not a deny-list', async () => {
  const mock = installQueryMock(() => ({ rows: [{ id: home.id, name: home.name }] }));
  try {
    const rows = await listEmployeeBranches('employee-1', home.id);
    assert.deepEqual(rows.map((row) => row.id), [home.id]);
    const [{ sql, params }] = mock.calls;
    assert.match(sql, /b\.is_active = true/);
    assert.match(sql, /a\.is_active = false/); // explicit deny still wins
    assert.match(sql, /grant_row\.is_active = true/); // explicit allow rows
    assert.match(sql, /b\.id = u\.branch_id/); // users home branch
    assert.match(sql, /b\.id = bb\.branch_id/); // barbers home branch
    assert.match(sql, /u\.role = any\(\$2::text\[\]\)/); // network roles, loaded from DB
    assert.equal(params[0], 'employee-1');
    assert.deepEqual([...params[1]].sort(), ['admin', 'admin_network', 'super-manager']);
    assert.equal(params[2], home.id);
  } finally {
    mock.restore();
  }
});

test('listEmployeeBranches does not fall back to the home branch when every branch is denied', async () => {
  const mock = installQueryMock(() => ({ rows: [] }));
  try {
    const rows = await listEmployeeBranches('employee-1', home.id);
    assert.deepEqual(rows, []);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test('listEmployeeBranches falls back to the home branch only when the access table is missing', async () => {
  const mock = installQueryMock((sql) => {
    if (/employee_branch_access/.test(sql)) {
      throw Object.assign(new Error('relation "employee_branch_access" does not exist'), { code: '42P01' });
    }
    return { rows: [{ id: home.id, name: home.name }] };
  });
  try {
    const rows = await listEmployeeBranches('employee-1', home.id);
    assert.deepEqual(rows.map((row) => row.id), [home.id]);
  } finally {
    mock.restore();
  }
});

test('resolveEmployeeBranch denies a branch the employee was never granted', async () => {
  const mock = installQueryMock(() => ({ rows: [{ id: home.id, name: home.name }] }));
  try {
    await assert.rejects(
      resolveEmployeeBranch({ employeeId: 'employee-1', requestedBranchId: other.id, fallbackBranchId: home.id }),
      (error) => error.code === 'BRANCH_ACCESS_DENIED',
    );
  } finally {
    mock.restore();
  }
});

// ---- backfill migration ----

test('backfill SQL is idempotent and only grants allow rows (never flips denies)', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'postgres', 'employee_branch_access_allowlist_backfill.sql'),
    'utf8',
  ).toLowerCase();
  assert.match(sql, /insert into employee_branch_access/);
  assert.match(sql, /on conflict \(employee_id, branch_id\) do nothing/);
  assert.match(sql, /from queue_entries/);
  assert.match(sql, /from employee_active_branches/);
  assert.doesNotMatch(sql, /\bupdate\s+employee_branch_access\b/);
  assert.doesNotMatch(sql, /\bdelete\s+from\s+employee_branch_access\b/);
});
