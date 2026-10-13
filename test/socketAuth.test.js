const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const {
  canAccessSocketBranch,
  extractSocketToken,
  verifySocketToken,
} = require('../src/socketAuth');

const secret = 'socket-test-secret';
const branchA = '11111111-1111-4111-8111-111111111111';
const branchB = '22222222-2222-4222-8222-222222222222';

function socket({ auth, authorization } = {}) {
  return { handshake: { auth, headers: { authorization } } };
}

test('rejects an anonymous Socket.IO handshake', () => {
  assert.throws(() => verifySocketToken(socket(), secret), /authentication is required/);
});

test('accepts a valid employee token from handshake auth', () => {
  const token = jwt.sign({ sub: 'employee-1', role: 'barber', branchId: branchA }, secret);
  const result = verifySocketToken(socket({ auth: { token } }), secret);
  assert.equal(result.payload.sub, 'employee-1');
  assert.equal(extractSocketToken(socket({ auth: { token } })), token);
});

test('branch access uses server-side state and rejects branch spoofing', () => {
  const payload = { sub: 'employee-1', role: 'barber', branchId: branchA };
  const state = { user: { branch_id: branchA }, barber: { branch_id: branchA }, activeBranches: [] };
  assert.equal(canAccessSocketBranch({ payload, state, branchId: branchA }), true);
  assert.equal(canAccessSocketBranch({ payload, state, branchId: branchB }), false);
});

test('network administrators may access an authorized branch while malformed IDs fail', () => {
  const payload = { sub: 'admin-1', role: 'admin_network' };
  assert.equal(canAccessSocketBranch({ payload, state: {}, branchId: branchB }), true);
  assert.equal(canAccessSocketBranch({ payload, state: {}, branchId: 'not-a-branch' }), false);
});
