const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
const { resolveCreateBranchId } = require('../src/models/expenses');

test('network administrators can create expenses for the selected branch', () => {
  for (const role of ['admin', 'admin_network', 'super-manager']) {
    assert.equal(
      resolveCreateBranchId({ role, branchId: null }, { branch_id: 'selected-branch' }),
      'selected-branch',
    );
  }
});

test('global administrators fall back to their token branch when no branch is selected', () => {
  assert.equal(
    resolveCreateBranchId({ role: 'admin', branchId: 'token-branch' }, {}),
    'token-branch',
  );
});

test('branch-scoped administrators and managers cannot override their branch', () => {
  for (const role of ['admin_branch', 'manager']) {
    assert.equal(
      resolveCreateBranchId({ role, branchId: 'own-branch' }, { branch_id: 'other-branch' }),
      'own-branch',
    );
  }
});
