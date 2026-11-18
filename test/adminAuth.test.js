const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// Default archived/role helpers load modules that need database env; no
// query is made because loadState is stubbed.
process.env.PGHOST ||= '127.0.0.1';
process.env.PGPORT ||= '5432';
process.env.PGDATABASE ||= 'admin-auth-tests';
process.env.PGUSER ||= 'admin-auth-tests';
process.env.PGPASSWORD ||= 'unit-test-only';

const { createAdminAuth, createNetworkWriteAuth } = require('../src/utils/adminAuth');

const SECRET = 'loyalty-test-secret';
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const bearer = (payload) => ({ headers: { authorization: `Bearer ${jwt.sign(payload, SECRET)}` } });
// Multi-tenancy: DB users carry their company (MULTI_TENANCY Phase 1).
const stateWithRole = (role) => async (id) => ({ user: { id, role, branch_id: 'branch-1', company_id: 'company-1', company_status: 'active' }, barber: null });

test('admin loyalty endpoints require an authenticated administrator role', async () => {
  const authorize = createAdminAuth({ secret: SECRET, loadState: stateWithRole('admin_network') });

  const noToken = responseRecorder();
  assert.equal(await authorize({ headers: {} }, noToken), null);
  assert.equal(noToken.statusCode, 401);

  const invalid = responseRecorder();
  assert.equal(await authorize({ headers: { authorization: 'Bearer invalid' } }, invalid), null);
  assert.equal(invalid.statusCode, 401);

  const client = responseRecorder();
  const asClient = createAdminAuth({ secret: SECRET, loadState: stateWithRole('marketplace') });
  assert.equal(await asClient(bearer({ role: 'admin_network', sub: ADMIN_ID }), client), null);
  assert.equal(client.statusCode, 403);

  const admin = responseRecorder();
  const auth = await authorize(bearer({ role: 'marketplace', sub: ADMIN_ID }), admin);
  assert.equal(auth.sub, ADMIN_ID);
  assert.equal(auth.role, 'admin_network');
  assert.equal(admin.statusCode, 200);
});

test('createAdminAuth uses the caller-specific forbidden message', async () => {
  const generic = createAdminAuth({ secret: SECRET, loadState: stateWithRole('barber') });
  const genericRes = responseRecorder();
  await generic(bearer({ sub: ADMIN_ID }), genericRes);
  assert.equal(genericRes.statusCode, 403);
  assert.doesNotMatch(genericRes.body.error, /loyalty/i);

  const custom = createAdminAuth({
    secret: SECRET,
    loadState: stateWithRole('barber'),
    forbiddenMessage: 'Only admins can manage widgets',
  });
  const customRes = responseRecorder();
  await custom(bearer({ sub: ADMIN_ID }), customRes);
  assert.equal(customRes.body.error, 'Only admins can manage widgets');
});

test('network write auth lets only network roles change network-wide settings', async () => {
  for (const role of ['admin_network', 'admin', 'super-manager']) {
    const authorize = createNetworkWriteAuth({
      secret: SECRET,
      loadState: stateWithRole(role),
      roles: new Set(['admin_network', 'admin', 'super-manager', 'admin_branch']),
    });
    const res = responseRecorder();
    const auth = await authorize(bearer({ sub: ADMIN_ID }), res);
    assert.equal(auth?.role, role, `${role} should be allowed`);
    assert.equal(res.statusCode, 200);
  }

  for (const role of ['admin_branch', 'merchant']) {
    const authorize = createNetworkWriteAuth({
      secret: SECRET,
      loadState: stateWithRole(role),
      networkMessage: 'Only network administrators can change loyalty settings',
    });
    const res = responseRecorder();
    // The token claims a network role; the DB role must win.
    assert.equal(await authorize(bearer({ role: 'admin_network', sub: ADMIN_ID }), res), null);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'Only network administrators can change loyalty settings');
  }
});
