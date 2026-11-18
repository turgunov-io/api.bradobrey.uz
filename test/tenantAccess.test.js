// Phase 1 step B1: company (tenant) checks on every staff request.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'tenant-access-secret';

const { checkTenantAccess, PLATFORM_OWNER_ROLE } = require('../src/utils/tenant');
const { createEmployeeAccessMiddleware } = require('../src/middleware/employeeAccess');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

const sign = (claims) => jwt.sign({ sub: USER_ID, ...claims }, process.env.JWT_SECRET);

function recorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function run(middleware, { token, path = '/api/branches', method = 'GET' }) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, method, originalUrl: path, path };
  const res = recorder();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

const stateFor = (user, barber = null) => async () => ({ user: { id: USER_ID, ...user }, barber });

// ------------------------------------------------------------ pure check

test('checkTenantAccess derives the company from the DB for old tokens without companyId', () => {
  const result = checkTenantAccess({ payload: { role: 'admin' }, user: { role: 'admin', company_id: COMPANY_A, company_status: 'active' } });
  assert.deepEqual(result, { ok: true, tenant: { companyId: COMPANY_A, isPlatformOwner: false } });
});

test('checkTenantAccess rejects a token whose companyId differs from the DB', () => {
  const result = checkTenantAccess({ payload: { companyId: COMPANY_B }, user: { role: 'admin', company_id: COMPANY_A, company_status: 'active' } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'TOKEN_COMPANY_MISMATCH');
});

test('checkTenantAccess rejects users of a suspended company with 403 COMPANY_SUSPENDED', () => {
  const result = checkTenantAccess({ payload: { companyId: COMPANY_A }, user: { role: 'barber', company_id: COMPANY_A, company_status: 'suspended' } });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'COMPANY_SUSPENDED');
});

test('checkTenantAccess fails closed when the company is unknown', () => {
  assert.equal(checkTenantAccess({ payload: {}, user: { role: 'admin', company_id: null } }).status, 403);
  assert.equal(checkTenantAccess({ payload: {}, user: { role: 'admin', company_id: COMPANY_A } }).status, 403);
});

test('checkTenantAccess marks platform owners (no company) and rejects a company claim for them', () => {
  assert.deepEqual(
    checkTenantAccess({ payload: { role: PLATFORM_OWNER_ROLE }, user: { role: PLATFORM_OWNER_ROLE, company_id: null } }),
    { ok: true, tenant: { companyId: null, isPlatformOwner: true } },
  );
  assert.equal(checkTenantAccess({ payload: { companyId: COMPANY_A }, user: { role: PLATFORM_OWNER_ROLE, company_id: null } }).status, 401);
});

// ------------------------------------------------- enforceEmployeeAccess

test('enforceEmployeeAccess exposes req.tenant from the DB-loaded company', async () => {
  const middleware = createEmployeeAccessMiddleware({
    loadState: stateFor({ role: 'admin', company_id: COMPANY_A, company_status: 'active' }),
  });
  const { req, nextCalled } = await run(middleware, { token: sign({ role: 'admin', companyId: COMPANY_A }) });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.tenant, { companyId: COMPANY_A, isPlatformOwner: false });
});

test('enforceEmployeeAccess accepts old tokens without companyId (derived from DB)', async () => {
  const middleware = createEmployeeAccessMiddleware({
    loadState: stateFor({ role: 'admin', company_id: COMPANY_A, company_status: 'active' }),
  });
  const { req, nextCalled } = await run(middleware, { token: sign({ role: 'admin' }) });
  assert.equal(nextCalled, true);
  assert.equal(req.tenant.companyId, COMPANY_A);
});

test('enforceEmployeeAccess rejects a token/DB company mismatch', async () => {
  const middleware = createEmployeeAccessMiddleware({
    loadState: stateFor({ role: 'admin', company_id: COMPANY_A, company_status: 'active' }),
  });
  const { res, nextCalled } = await run(middleware, { token: sign({ role: 'admin', companyId: COMPANY_B }) });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'TOKEN_COMPANY_MISMATCH');
});

test('enforceEmployeeAccess rejects staff of a suspended company', async () => {
  const middleware = createEmployeeAccessMiddleware({
    loadState: stateFor({ role: 'admin', company_id: COMPANY_A, company_status: 'suspended' }),
  });
  const { res, nextCalled } = await run(middleware, { token: sign({ role: 'admin', companyId: COMPANY_A }) });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'COMPANY_SUSPENDED');
});

test('enforceEmployeeAccess checks merchant tokens too', async () => {
  const middleware = createEmployeeAccessMiddleware({
    loadState: stateFor({ role: 'merchant', company_id: COMPANY_A, company_status: 'suspended' }),
  });
  const { res } = await run(middleware, { token: sign({ role: 'merchant' }) });
  assert.equal(res.statusCode, 403);
});

test('platform_owner is denied on tenant data routes and allowed on /api/platform', async () => {
  const middleware = createEmployeeAccessMiddleware({
    loadState: stateFor({ role: PLATFORM_OWNER_ROLE, company_id: null }),
  });
  const token = sign({ role: PLATFORM_OWNER_ROLE });

  const denied = await run(middleware, { token, path: '/api/finance/overview' });
  assert.equal(denied.nextCalled, false);
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.res.body.code, 'PLATFORM_OWNER_NO_TENANT_ACCESS');

  const allowed = await run(middleware, { token, path: '/api/platform/companies' });
  assert.equal(allowed.nextCalled, true);
  assert.deepEqual(allowed.req.tenant, { companyId: null, isPlatformOwner: true });
});

test('platform_owner detection uses the DB role, not the token role', async () => {
  const middleware = createEmployeeAccessMiddleware({
    loadState: stateFor({ role: PLATFORM_OWNER_ROLE, company_id: null }),
  });
  const { res } = await run(middleware, { token: sign({ role: 'admin' }), path: '/api/branches' });
  assert.equal(res.statusCode, 403);
});

test('marketplace client tokens are not tenant-checked here', async () => {
  let loaded = false;
  const middleware = createEmployeeAccessMiddleware({ loadState: async () => { loaded = true; return {}; } });
  const { nextCalled, req } = await run(middleware, { token: sign({ role: 'marketplace' }) });
  assert.equal(nextCalled, true);
  assert.equal(loaded, false);
  assert.equal(req.tenant, undefined);
});
