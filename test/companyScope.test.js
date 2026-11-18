// Phase 1 step B1: "network roles see everything" -> "network roles see their
// whole company". Guards, scope helpers and branch lookups are restricted to
// branches with company_id = the caller's company.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'company-scope-secret';

const postgres = require('../src/config/postgres');
const { createStaffAccessGuard } = require('../src/middleware/staffAccess');
const { createEmployeeManagementGuard } = require('../src/middleware/employeeManagement');
const { createKioskAuth } = require('../src/middleware/kioskAuth');
const { createKioskRegistry } = require('../src/services/kioskRegistration');
const { canAccessSocketBranch } = require('../src/socketAuth');
const { resolveAuthorizedScope, effectivePermissions } = require('../src/utils/employeeQualityAccess');
const { listEmployeeBranches, selectEmployeeBranches } = require('../src/utils/employeeBranches');
const services = require('../src/models/services');
const finance = require('../src/models/finance');

const SECRET = 'company-scope-secret';
const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const ADMIN_A = '10000000-0000-4000-8000-00000000000a';
const OWNER_ID = '10000000-0000-4000-8000-0000000000ff';
const TARGET_B = '20000000-0000-4000-8000-00000000000b';

const sign = (claims) => jwt.sign(claims, SECRET, { expiresIn: '1h' });
const active = (companyId) => ({ company_id: companyId, company_status: 'active' });

function res() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function run(middleware, req) {
  const response = res();
  let nextCalled = false;
  await middleware(req, response, () => { nextCalled = true; });
  return { req, res: response, nextCalled };
}

const bearerReq = (claims, extra = {}) => ({ headers: { authorization: `Bearer ${sign(claims)}` }, params: {}, query: {}, body: {}, ...extra });

// ------------------------------------------------------------- staffAccess

test('staffAccess rejects staff of a suspended company and exposes req.tenant', async () => {
  const actors = {
    [ADMIN_A]: { user: { id: ADMIN_A, role: 'admin', branch_id: null, ...active(COMPANY_A) }, permissions: [] },
  };
  const guard = createStaffAccessGuard({ secret: SECRET, loadActor: async (id) => actors[id] || null });

  const ok = await run(guard.requireStaff({ anyOf: ['dashboard.access'] }), bearerReq({ sub: ADMIN_A, role: 'admin' }));
  assert.equal(ok.nextCalled, true);
  assert.deepEqual(ok.req.tenant, { companyId: COMPANY_A, isPlatformOwner: false });
  assert.equal(ok.req.staffAccess.actor.company_id, COMPANY_A);

  actors[ADMIN_A].user.company_status = 'suspended';
  const suspended = await run(guard.requireStaff(), bearerReq({ sub: ADMIN_A, role: 'admin' }));
  assert.equal(suspended.res.statusCode, 403);
  assert.equal(suspended.res.body.code, 'COMPANY_SUSPENDED');

  actors[ADMIN_A].user.company_status = 'active';
  const mismatch = await run(guard.requireStaff(), bearerReq({ sub: ADMIN_A, role: 'admin', companyId: COMPANY_B }));
  assert.equal(mismatch.res.statusCode, 401);
});

test('staffAccess.authenticated() never admits the platform owner', async () => {
  const guard = createStaffAccessGuard({
    secret: SECRET,
    loadActor: async () => ({ user: { id: OWNER_ID, role: 'platform_owner', branch_id: null, company_id: null }, permissions: [] }),
  });
  const { res: response, nextCalled } = await run(guard.authenticated(), bearerReq({ sub: OWNER_ID, role: 'platform_owner' }));
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 403);
});

// ------------------------------------------------------ employeeManagement

function managementGuard({ targets = {}, branches = {} } = {}) {
  return createEmployeeManagementGuard({
    secret: SECRET,
    loadActor: async () => ({ user: { id: ADMIN_A, role: 'admin_network', branch_id: null, ...active(COMPANY_A) }, permissions: [] }),
    loadTarget: async (id) => targets[id] || null,
    loadBranch: async (id) => branches[id] || null,
  });
}

test('employee management: network admins only manage employees of their own company', async () => {
  const guard = managementGuard({
    targets: { [TARGET_B]: { id: TARGET_B, role: 'barber', branch_id: BRANCH_B1, company_id: COMPANY_B } },
  });
  const { res: response, nextCalled } = await run(guard.authorize('update'), bearerReq({ sub: ADMIN_A, role: 'admin_network' }, { params: { id: TARGET_B } }));
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 404);
});

test('employee management: the directory is pinned to the caller company', async () => {
  const guard = managementGuard();
  const { req, nextCalled } = await run(guard.authorize('read'), bearerReq({ sub: ADMIN_A, role: 'admin_network' }));
  assert.equal(nextCalled, true);
  assert.equal(req.employeeManagement.companyId, COMPANY_A);
});

test('employee management: a network admin cannot place an employee in another company branch', async () => {
  const guard = managementGuard({
    branches: {
      [BRANCH_A1]: { id: BRANCH_A1, company_id: COMPANY_A },
      [BRANCH_B1]: { id: BRANCH_B1, company_id: COMPANY_B },
    },
  });
  const req = bearerReq({ sub: ADMIN_A, role: 'admin_network' }, { body: { branch_id: BRANCH_B1, role: 'barber' } });
  const authorized = await run(guard.authorize('create'), req);
  assert.equal(authorized.nextCalled, true);
  const checked = await run(guard.checkPayload, req);
  assert.equal(checked.nextCalled, false);
  assert.equal(checked.res.statusCode, 403);

  const own = bearerReq({ sub: ADMIN_A, role: 'admin_network' }, { body: { branch_id: BRANCH_A1, role: 'barber' } });
  await run(guard.authorize('create'), own);
  assert.equal((await run(guard.checkPayload, own)).nextCalled, true);
});

// ---------------------------------------------------------------- kioskAuth

test('kiosk bearer access rejects staff of a suspended company and branches of other companies', async () => {
  let status = 'active';
  const auth = createKioskAuth({
    verifyBearer: () => ({ sub: ADMIN_A, role: 'admin' }),
    loadStaff: async () => ({ user: { id: ADMIN_A, role: 'admin', branch_id: null, company_id: COMPANY_A, company_status: status }, barber: null }),
    resolveScope: async () => [BRANCH_A1],
    env: { KIOSK_AUTH_ENFORCE: 'true' },
  })({ allowBearer: true });

  const other = await run(auth, { headers: { authorization: 'Bearer x' }, params: { branch_id: BRANCH_B1 }, query: {}, method: 'GET' });
  assert.equal(other.res.statusCode, 403);
  assert.equal(other.res.body.code, 'KIOSK_BRANCH_FORBIDDEN');

  const own = await run(auth, { headers: { authorization: 'Bearer x' }, params: { branch_id: BRANCH_A1 }, query: {}, method: 'GET' });
  assert.equal(own.nextCalled, true);
  assert.deepEqual(own.req.tenant, { companyId: COMPANY_A, isPlatformOwner: false });

  status = 'suspended';
  const suspended = await run(auth, { headers: { authorization: 'Bearer x' }, params: { branch_id: BRANCH_A1 }, query: {}, method: 'GET' });
  assert.equal(suspended.res.statusCode, 403);
  assert.equal(suspended.res.body.code, 'COMPANY_SUSPENDED');
});

test('kiosk device token resolves the company via its branch; a suspended company is rejected', async () => {
  let kiosk = { id: 'k1', branchId: BRANCH_A1, companyId: COMPANY_A, companyStatus: 'active' };
  const auth = createKioskAuth({ authenticate: async () => kiosk, env: {} })();
  const ok = await run(auth, { headers: { 'x-kiosk-token': 't' }, params: {}, query: {}, method: 'GET' });
  assert.equal(ok.nextCalled, true);
  assert.deepEqual(ok.req.kiosk, { id: 'k1', branchId: BRANCH_A1, companyId: COMPANY_A });
  assert.deepEqual(ok.req.tenant, { companyId: COMPANY_A, isPlatformOwner: false });

  kiosk = { ...kiosk, companyStatus: 'suspended' };
  const suspended = await run(auth, { headers: { 'x-kiosk-token': 't' }, params: {}, query: {}, method: 'GET' });
  assert.equal(suspended.res.statusCode, 403);
  assert.equal(suspended.res.body.code, 'COMPANY_SUSPENDED');
});

// ------------------------------------------------- kiosk device management

test('kiosk device list/delete for network roles is limited to the actor company', async () => {
  const listed = [];
  const repo = {
    async listKiosks(args) { listed.push(args); return []; },
    async findKioskById(id) { return { id, branch_id: BRANCH_B1, company_id: COMPANY_B }; },
    async deleteKiosk() { throw new Error('must not delete'); },
  };
  const registry = createKioskRegistry({ repo });
  const actor = { id: ADMIN_A, role: 'admin_network', branch_id: null, company_id: COMPANY_A };
  assert.equal((await registry.listKiosks({ actor })).status, 200);
  assert.deepEqual(listed[0], { branchId: null, companyId: COMPANY_A });

  const removed = await registry.removeKiosk({ id: '30000000-0000-4000-8000-000000000001', actor });
  assert.equal(removed.status, 404);
});

// ----------------------------------------------------------------- sockets

test('socket join_branch requires the branch to belong to the caller company', () => {
  const base = { payload: { role: 'admin_network' }, state: { user: { role: 'admin_network', company_id: COMPANY_A } } };
  assert.equal(canAccessSocketBranch({ ...base, branchId: BRANCH_A1, branchCompanyId: COMPANY_A }), true);
  assert.equal(canAccessSocketBranch({ ...base, branchId: BRANCH_B1, branchCompanyId: COMPANY_B }), false);
  assert.equal(canAccessSocketBranch({ ...base, branchId: BRANCH_B1, branchCompanyId: null }), false);

  const barber = {
    payload: { role: 'barber', branchId: BRANCH_B1 },
    state: { user: { role: 'barber', branch_id: BRANCH_B1, company_id: COMPANY_A }, activeBranches: [] },
  };
  // Even a branch from the token/home branch is refused if it is another company's.
  assert.equal(canAccessSocketBranch({ ...barber, branchId: BRANCH_B1, branchCompanyId: COMPANY_B }), false);
});

// ------------------------------------------------------ statistics scopes

test('statistics branch scope with global permission is limited to company branches', () => {
  const permissions = effectivePermissions('admin', []);
  const user = { id: ADMIN_A, branch_id: null, company_id: COMPANY_A };
  const inside = resolveAuthorizedScope({ permissions, query: { scope: 'branch', branch_id: BRANCH_A1 }, role: 'admin', user, companyBranchIds: [BRANCH_A1] });
  assert.equal(inside.type, 'branch');
  const outside = resolveAuthorizedScope({ permissions, query: { scope: 'branch', branch_id: BRANCH_B1 }, role: 'admin', user, companyBranchIds: [BRANCH_A1] });
  assert.equal(outside.status, 403);
  const global = resolveAuthorizedScope({ permissions, query: { scope: 'global' }, role: 'admin', user, companyBranchIds: [BRANCH_A1] });
  assert.equal(global.companyId, COMPANY_A);
  assert.deepEqual(global.branchIds, [BRANCH_A1]);
});

// ------------------------------------------------------ employee branches

test('listEmployeeBranches only returns branches of the employee company', async () => {
  const seen = [];
  const original = postgres.db.query;
  postgres.db.query = async (sql, params) => { seen.push({ sql, params }); return { rows: [] }; };
  try {
    await listEmployeeBranches(ADMIN_A, null);
  } finally {
    postgres.db.query = original;
  }
  assert.match(seen[0].sql, /b\.company_id = \(select company_id from users where id = \$1\)/);
});

test('selectEmployeeBranches drops branches of other companies when a company is given', () => {
  const branches = [{ id: BRANCH_A1, company_id: COMPANY_A }, { id: BRANCH_B1, company_id: COMPANY_B }];
  const selected = selectEmployeeBranches(branches, [], { role: 'admin', companyId: COMPANY_A });
  assert.deepEqual(selected.map((branch) => branch.id), [BRANCH_A1]);
});

// --------------------------------------- legacy handlers on company scopes

test('company-wide scopes keep company-level (NULL branch) services editable; branch scopes do not', () => {
  const companyWide = Object.defineProperty([BRANCH_A1], 'companyWide', { value: true });
  assert.equal(services.canModifyService(companyWide, null), true);
  assert.equal(services.canModifyService(companyWide, BRANCH_B1), false);
  assert.equal(services.canModifyService([BRANCH_A1], null), false);
});

test('finance overview: company-wide scope keeps the whole-company view, limited to the company', () => {
  const companyWide = Object.defineProperty([BRANCH_A1], 'companyWide', { value: true });
  assert.deepEqual(finance.resolveBranchFilter({ branchScope: companyWide }, BRANCH_B1), { branchFilter: [BRANCH_A1] });
});
