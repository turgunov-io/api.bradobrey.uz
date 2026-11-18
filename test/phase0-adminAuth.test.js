// Phase 0.10 / shared branch-scope helpers (MULTI_TENANCY.md section 2).
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';

const {
  createAdminAuth,
  createBranchScopeMiddleware,
  createDbActorMiddleware,
  isBranchAllowed,
  isNetworkRole,
  resolveAllowedBranchIds,
  resolveStaffBranchScope,
} = require('../src/utils/adminAuth');
const { NETWORK_ROLES } = require('../src/utils/employeeQualityAccess');

const SECRET = 'phase0-admin-secret';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRANCH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function recorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const bearer = (payload) => ({ headers: { authorization: `Bearer ${jwt.sign(payload, SECRET)}` } });

test('authorizeAdmin takes the role from the database, not from the token', async () => {
  const authorize = createAdminAuth({
    secret: SECRET,
    loadState: async () => ({ user: { id: USER_ID, role: 'barber', branch_id: BRANCH_A }, barber: null }),
  });
  const res = recorder();
  const result = await authorize(bearer({ sub: USER_ID, role: 'admin_network' }), res);
  assert.equal(result, null);
  assert.equal(res.statusCode, 403);
});

test('authorizeAdmin accepts a DB admin and returns the DB role', async () => {
  const authorize = createAdminAuth({
    secret: SECRET,
    loadState: async () => ({ user: { id: USER_ID, role: 'admin', branch_id: null }, barber: null }),
  });
  const res = recorder();
  const result = await authorize(bearer({ sub: USER_ID, role: 'barber' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(result.role, 'admin');
  assert.equal(result.sub, USER_ID);
});

test('authorizeAdmin rejects missing, archived and non-uuid subjects', async () => {
  const missing = createAdminAuth({ secret: SECRET, loadState: async () => ({ user: null, barber: null }) });
  let res = recorder();
  assert.equal(await missing(bearer({ sub: USER_ID, role: 'admin' }), res), null);
  assert.equal(res.statusCode, 401);

  const archived = createAdminAuth({
    secret: SECRET,
    loadState: async () => ({ user: { id: USER_ID, role: 'admin' }, barber: { is_archived: true } }),
  });
  res = recorder();
  assert.equal(await archived(bearer({ sub: USER_ID, role: 'admin' }), res), null);
  assert.equal(res.statusCode, 403);

  let loaded = false;
  const nonUuid = createAdminAuth({ secret: SECRET, loadState: async () => { loaded = true; return null; } });
  res = recorder();
  assert.equal(await nonUuid(bearer({ sub: 'client-1', role: 'admin' }), res), null);
  assert.equal(res.statusCode, 401);
  assert.equal(loaded, false);

  res = recorder();
  assert.equal(await nonUuid({ headers: {} }, res), null);
  assert.equal(res.statusCode, 401);
});

test('authorizeAdmin answers 500 when the database lookup fails', async () => {
  const authorize = createAdminAuth({ secret: SECRET, loadState: async () => { throw new Error('db down'); } });
  const res = recorder();
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await authorize(bearer({ sub: USER_ID, role: 'admin' }), res), null);
  } finally {
    console.error = original;
  }
  assert.equal(res.statusCode, 500);
});

test('network roles reuse the canonical list and are unrestricted', async () => {
  for (const role of NETWORK_ROLES) {
    assert.equal(isNetworkRole(role), true);
    assert.equal(await resolveAllowedBranchIds({ id: USER_ID, role }), null);
    assert.equal(await resolveStaffBranchScope({ id: USER_ID, role }, BRANCH_A), null);
  }
  for (const role of ['admin_branch', 'merchant', 'manager', 'barber']) assert.equal(isNetworkRole(role), false);
});

test('admin_branch is limited to the employee branch helper result', async () => {
  const calls = [];
  const scope = await resolveAllowedBranchIds(
    { id: USER_ID, role: 'admin_branch', branch_id: BRANCH_A },
    { listBranches: async (...args) => { calls.push(args); return [{ id: BRANCH_A }]; } },
  );
  assert.deepEqual(scope, [BRANCH_A]);
  assert.deepEqual(calls, [[USER_ID, BRANCH_A]]);
});

test('merchant is limited to branches of its barbershop plus its home branch', async () => {
  const scope = await resolveAllowedBranchIds(
    { id: USER_ID, role: 'merchant', branch_id: BRANCH_B },
    { query: async () => ({ rows: [{ id: BRANCH_A }] }) },
  );
  assert.deepEqual(scope.sort(), [BRANCH_A, BRANCH_B].sort());

  const legacy = await resolveAllowedBranchIds(
    { id: USER_ID, role: 'merchant', branch_id: null },
    { query: async () => { const error = new Error('column missing'); error.code = '42703'; throw error; } },
  );
  assert.deepEqual(legacy, []);
});

test('session-bound roles are pinned to the session branch', async () => {
  assert.deepEqual(await resolveStaffBranchScope({ id: USER_ID, role: 'manager' }, BRANCH_B), [BRANCH_B]);
  assert.deepEqual(await resolveStaffBranchScope({ id: USER_ID, role: 'manager' }, null), []);
});

test('isBranchAllowed treats null as unrestricted and rejects empty ids', () => {
  assert.equal(isBranchAllowed(null, BRANCH_A), true);
  assert.equal(isBranchAllowed([BRANCH_A], BRANCH_A), true);
  assert.equal(isBranchAllowed([BRANCH_A], BRANCH_B), false);
  assert.equal(isBranchAllowed([BRANCH_A], null), false);
  assert.equal(isBranchAllowed([], BRANCH_A), false);
});

test('branch scope middleware uses the DB actor from staffAccess', async () => {
  const seen = [];
  const middleware = createBranchScopeMiddleware({ resolve: async (user) => { seen.push(user); return [BRANCH_A]; } });
  const req = { staffAccess: { actor: { id: USER_ID, role: 'admin_branch', branch_id: BRANCH_A }, role: 'admin_branch' } };
  let nextCalled = false;
  await middleware(req, recorder(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.branchScope, [BRANCH_A]);
  assert.equal(seen[0].role, 'admin_branch');

  const res = recorder();
  await middleware({}, res, () => assert.fail('must not continue without an actor'));
  assert.equal(res.statusCode, 401);
});

test('db actor middleware replaces the token role with the database role', async () => {
  const middleware = createDbActorMiddleware({
    secret: SECRET,
    loadState: async () => ({ user: { id: USER_ID, role: 'admin_branch', branch_id: BRANCH_A }, barber: null }),
    resolveScope: async () => [BRANCH_A],
  });
  const req = bearer({ sub: USER_ID, role: 'admin_network' });
  let nextCalled = false;
  await middleware(req, recorder(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.dbActor.role, 'admin_branch');
  assert.deepEqual(req.dbActor.branchScope, [BRANCH_A]);
});

test('db actor middleware rejects deleted and archived users, passes through invalid tokens', async () => {
  const gone = createDbActorMiddleware({ secret: SECRET, loadState: async () => ({ user: null }) });
  let res = recorder();
  await gone(bearer({ sub: USER_ID, role: 'admin' }), res, () => assert.fail('must not continue'));
  assert.equal(res.statusCode, 401);

  const archived = createDbActorMiddleware({
    secret: SECRET,
    loadState: async () => ({ user: { id: USER_ID, role: 'admin' }, barber: { is_archived: true } }),
  });
  res = recorder();
  await archived(bearer({ sub: USER_ID, role: 'admin' }), res, () => assert.fail('must not continue'));
  assert.equal(res.statusCode, 403);

  const req = { headers: { authorization: 'Bearer invalid' } };
  let nextCalled = false;
  await gone(req, recorder(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.dbActor, undefined);
});
