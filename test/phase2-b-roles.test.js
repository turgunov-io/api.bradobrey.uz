// Phase 2 (group B) M3: a staff role is always the DB role. A token issued
// before a role change is rejected (401 TOKEN_ROLE_STALE); queue transfers and
// notifications read the role (and session branch) from the DB-validated
// context set by middleware/employeeAccess, never from the token alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'phase2-b-roles-secret';

const { createEmployeeAccessMiddleware, isTokenRoleStale } = require('../src/middleware/employeeAccess');
const queueTransfers = require('../src/models/queueTransfers');
const notificationModel = require('../src/models/notifications');
const { installPoolMock, makeRes } = require('./helpers/tenantMocks');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';

const sign = (claims) => jwt.sign({ sub: USER_ID, companyId: COMPANY_A, ...claims }, process.env.JWT_SECRET);
const stateFor = (role) => async () => ({
  user: { id: USER_ID, role, company_id: COMPANY_A, company_status: 'active' },
  barber: null,
});

async function runMiddleware({ tokenRole, dbRole }) {
  const middleware = createEmployeeAccessMiddleware({
    loadState: stateFor(dbRole),
    validateSession: async () => ({ valid: true }),
  });
  const req = { headers: { authorization: `Bearer ${sign({ role: tokenRole, branchId: 'b', jti: 's' })}` }, method: 'GET', originalUrl: '/api/branches', path: '/api/branches' };
  const res = makeRes();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

test('employeeAccess: a token whose role differs from the DB role is rejected as stale', async () => {
  const promoted = await runMiddleware({ tokenRole: 'barber', dbRole: 'admin' });
  assert.equal(promoted.nextCalled, false);
  assert.equal(promoted.res.statusCode, 401);
  assert.equal(promoted.res.body.code, 'TOKEN_ROLE_STALE');

  const demoted = await runMiddleware({ tokenRole: 'admin_network', dbRole: 'admin_branch' });
  assert.equal(demoted.res.statusCode, 401);
  assert.equal(demoted.res.body.code, 'TOKEN_ROLE_STALE');
});

test('employeeAccess: matching roles pass (compared trimmed and case-insensitively)', async () => {
  const same = await runMiddleware({ tokenRole: 'admin', dbRole: 'admin' });
  assert.equal(same.nextCalled, true);
  assert.equal(isTokenRoleStale({ role: 'Admin' }, { role: ' admin ' }), false);
  assert.equal(isTokenRoleStale({ role: 'admin' }, { role: 'admin_network' }), true);
});

test('queueTransfers: without the DB-validated context the token is not trusted', async () => {
  const token = jwt.sign({ sub: USER_ID, role: 'barber', branchId: 'b' }, process.env.JWT_SECRET);
  const pool = installPoolMock(() => { throw new Error('must not query'); });
  try {
    const res = makeRes();
    await queueTransfers.outcomes({ headers: { authorization: `Bearer ${token}` }, query: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(pool.calls.length, 0);
  } finally { pool.restore(); }
});

test('queueTransfers: role comes from the DB account, not from the token', async () => {
  // Token still says barber, the DB account is an admin now: not a transfer role.
  const token = jwt.sign({ sub: USER_ID, role: 'barber', branchId: 'b' }, process.env.JWT_SECRET);
  const pool = installPoolMock(() => ({ rows: [] }));
  try {
    const res = makeRes();
    await queueTransfers.outcomes({
      headers: { authorization: `Bearer ${token}` },
      query: {},
      employeeAccess: { user: { id: USER_ID, role: 'admin' }, sessionValid: true },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(pool.calls.length, 0);

    const ok = makeRes();
    await queueTransfers.outcomes({
      headers: { authorization: `Bearer ${token}` },
      query: {},
      employeeAccess: { user: { id: USER_ID, role: 'barber' }, sessionValid: true },
    }, ok);
    assert.equal(ok.statusCode, 200);
  } finally { pool.restore(); }
});

test('notifications: checkToday is limited to admin roles taken from the DB', async () => {
  const { notifications } = notificationModel;
  const pool = installPoolMock(() => { throw new Error('must not query'); });
  try {
    // Token claims admin_network, DB account is a barber.
    const token = jwt.sign({ sub: USER_ID, role: 'admin_network' }, process.env.JWT_SECRET);
    const res = makeRes();
    await notifications.checkToday({
      headers: { authorization: `Bearer ${token}` },
      employeeAccess: { user: { id: USER_ID, role: 'barber' }, sessionValid: true },
      body: {},
    }, res);
    assert.equal(res.statusCode, 403);

    const missing = makeRes();
    await notifications.checkToday({ headers: { authorization: `Bearer ${token}` }, body: {} }, missing);
    assert.equal(missing.statusCode, 401);
    assert.equal(pool.calls.length, 0);
  } finally { pool.restore(); }
});
