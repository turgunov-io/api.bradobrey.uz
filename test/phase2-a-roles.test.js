// MULTI_TENANCY Phase 2 (group A, M3): authorization uses the role stored in
// the database, never the JWT `role` claim. A token minted while the user was
// an admin keeps working for up to JWT_EXPIRES_IN after a demotion otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'phase2-a-roles-secret';

const { installFakeDb } = require('./helpers/phase2aFakeDb');
const { installPoolMock, makeRes } = require('./helpers/tenantMocks');
const settings = require('../src/models/marketplace/settings');
const certificate = require('../src/models/certificate');
const kiosk = require('../src/models/kiosk');

const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const USER_B = '10000000-0000-4000-8000-00000000000b';

const bearer = (role) => `Bearer ${jwt.sign({ sub: USER_B, role }, process.env.JWT_SECRET)}`;
const staffSeed = (dbRole) => ({
  users: [{ id: USER_B, login: 'b', role: dbRole, branch_id: null, company_id: COMPANY_B }],
  barbers: [],
  companies: [{ id: COMPANY_B, status: 'active', is_default: true }],
  certificates: [],
  user_permissions: [],
});

async function run(fn, dbRole) {
  const fake = installFakeDb(staffSeed(dbRole));
  const pool = installPoolMock(() => ({ rows: [] }));
  const res = makeRes();
  try {
    await fn(res);
  } finally {
    fake.restore();
    pool.restore();
  }
  return res;
}

test('marketplace settings: a demoted admin (token says admin, DB says barber) is forbidden', async () => {
  const res = await run((r) => settings.list({ headers: { authorization: bearer('admin') }, tenant: { companyId: COMPANY_B } }, r), 'barber');
  assert.equal(res.statusCode, 403);
});

test('marketplace settings: the DB role decides, not a stale token claim', async () => {
  const res = await run((r) => settings.list({ headers: { authorization: bearer('barber') }, tenant: { companyId: COMPANY_B } }, r), 'admin_network');
  assert.equal(res.statusCode, 200);
});

test('certificates: a demoted admin (token says admin, DB says barber) is forbidden', async () => {
  const res = await run((r) => certificate.active({ headers: { authorization: bearer('admin') }, query: {}, params: {} }, r), 'barber');
  assert.equal(res.statusCode, 403);
});

test('certificates: the DB role decides, not a stale token claim', async () => {
  const res = await run((r) => certificate.active({ headers: { authorization: bearer('barber') }, query: {}, params: {} }, r), 'admin_network');
  assert.notEqual(res.statusCode, 403);
  assert.notEqual(res.statusCode, 401);
});

test('kiosk certificate check: a staff token without a DB-loaded staff role is forbidden', async () => {
  // Token claims "admin" but neither kioskAuth (req.kioskStaff) nor the
  // global employeeAccess middleware (req.employeeAccess.user) vouched for it.
  const res = await run((r) => kiosk.certificate({ headers: { authorization: bearer('admin') }, params: { id: 'A005' }, query: {} }, r), 'admin');
  assert.equal(res.statusCode, 403);

  const demoted = await run((r) => kiosk.certificate({
    headers: { authorization: bearer('admin') },
    params: { id: 'A005' },
    query: {},
    employeeAccess: { user: { id: USER_B, role: 'manager', company_id: COMPANY_B } },
  }, r), 'manager');
  assert.equal(demoted.statusCode, 403);
});

test('kiosk certificate check: a DB-verified staff role passes the role gate', async () => {
  const res = await run((r) => kiosk.certificate({
    headers: { authorization: bearer('manager') },
    params: { id: 'A005' },
    query: {},
    tenant: { companyId: COMPANY_B, isPlatformOwner: false },
    employeeAccess: { user: { id: USER_B, role: 'admin', company_id: COMPANY_B } },
  }, r), 'admin');
  assert.notEqual(res.statusCode, 403);
});
