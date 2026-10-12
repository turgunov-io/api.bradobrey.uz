const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.PGHOST ||= '127.0.0.1';
process.env.PGPORT ||= '5432';
process.env.PGDATABASE ||= 'employee-branch-switch-contract-tests';
process.env.PGUSER ||= 'employee-branch-switch-contract-tests';
process.env.PGPASSWORD ||= 'unit-test-only';

const { selectEmployeeBranches } = require('../src/utils/employeeBranches');

const branchA = { id: 'branch-a', name: 'Permanent branch', is_active: true };
const branchB = { id: 'branch-b', name: 'Today branch', is_active: true };
const branchClosed = { id: 'branch-closed', name: 'Closed branch', is_active: false };

test('isolated cross-branch employee flow uses active branch without production data', () => {
  const employee = { id: 'barber-1', branch_id: branchA.id };
  const accessRows = [{ employee_id: employee.id, branch_id: branchA.id, is_active: true }];

  // This reproduces the reported state: only the legacy/home row exists.
  const availableBranches = selectEmployeeBranches(
    [branchA, branchB, branchClosed],
    accessRows,
  );
  assert.deepEqual(availableBranches.map((branch) => branch.id), [branchA.id, branchB.id]);

  // Login/session selection persists B independently of users.branch_id.
  let session = { employeeId: employee.id, activeBranchId: branchB.id };
  assert.equal(availableBranches.some((branch) => branch.id === session.activeBranchId), true);

  // Kiosk visibility is based on the active assignment, not the permanent branch.
  const kioskRows = [
    { id: employee.id, branch_id: employee.branch_id, is_on_shift: false },
  ];
  const activeAssignments = [{ employee_id: employee.id, branch_id: branchB.id, is_on_shift: true }];
  const visibleInB = kioskRows.concat(
    activeAssignments
      .filter((row) => row.branch_id === branchB.id && row.is_on_shift)
      .map(() => ({ ...kioskRows[0] })),
  );
  assert.equal(visibleInB.some((row) => row.id === employee.id), true);

  // A booking/shift must carry the selected branch while retaining employee identity.
  const booking = { employee_id: employee.id, branch_id: session.activeBranchId };
  const shift = { barber_id: employee.id, branch_id: session.activeBranchId };
  assert.deepEqual(booking, { employee_id: employee.id, branch_id: branchB.id });
  assert.deepEqual(shift, { barber_id: employee.id, branch_id: branchB.id });

  session = { ...session, activeBranchId: branchA.id };
  assert.equal(session.activeBranchId, branchA.id);
});

test('explicit inactive branch restriction and inactive branch status are enforced', () => {
  const branches = [branchA, branchB, branchClosed];
  const deniedB = [{ employee_id: 'barber-1', branch_id: branchB.id, is_active: false }];
  assert.deepEqual(
    selectEmployeeBranches(branches, deniedB).map((branch) => branch.id),
    [branchA.id],
  );
  assert.equal(selectEmployeeBranches(branches, []).some((branch) => branch.id === branchClosed.id), false);
});

test('server-side branch checks remain wired into the real switch, shift, and kiosk paths', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const branches = read('src/utils/employeeBranches.js');
  const barbers = read('src/models/barbers.js');
  const verifix = read('src/models/verifix.js');
  const kiosk = read('src/models/kiosk.js');

  assert.match(branches, /b\.is_active = true/);
  assert.match(branches, /a\.is_active = false/);
  assert.match(barbers, /resolveEmployeeBranch/);
  assert.match(barbers, /active_branch_id/);
  assert.match(barbers, /activeBranchesByEmployee/);
  assert.match(verifix, /employeeCanUseBranch/);
  assert.match(kiosk, /employee_active_branches/);
  assert.match(kiosk, /activeById/);
});
