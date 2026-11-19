// Bradobrey's own network admins manage the platform (MULTI_TENANCY 12):
// /api/platform/companies* admits platform_owner OR admin_network/admin of the
// active DEFAULT company — role and company always from the DB. Management
// only: no tenant data of other companies is reachable through this grant.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'platform-default-admin-test-secret';

const {
  createPlatformController,
  createPlatformCompaniesGuard,
} = require('../src/models/platform');
const { canManagePlatform } = require('../src/utils/platformAccess');
const platformRouter = require('../src/routers/platform');
const { createEmployeeAccessMiddleware } = require('../src/middleware/employeeAccess');
const { makeRes } = require('./helpers/tenantMocks');

const DEFAULT_CO = 'dddddddd-0000-4000-8000-00000000000d';
const OTHER_CO = 'eeeeeeee-0000-4000-8000-00000000000e';
const OWNER = '10000000-0000-4000-8000-0000000000f1';
const id = (n) => `30000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const member = (n, role, companyId = DEFAULT_CO, extra = {}) => ({
  id: id(n),
  role,
  company_id: companyId,
  company_is_default: companyId === DEFAULT_CO,
  company_status: 'active',
  ...extra,
});

const CANDIDATES = {
  [OWNER]: { id: OWNER, role: 'platform_owner', company_id: null, company_is_default: null, company_status: null },
  [id(1)]: member(1, 'admin_network'),
  [id(2)]: member(2, 'admin'),
  [id(3)]: member(3, 'admin_branch'),
  [id(4)]: member(4, 'manager'),
  [id(5)]: member(5, 'barber'),
  [id(6)]: member(6, 'admin_network', OTHER_CO),
  [id(7)]: member(7, 'admin', OTHER_CO),
  [id(8)]: member(8, 'admin_network', DEFAULT_CO, { company_status: 'suspended' }),
  [id(9)]: member(9, 'super-manager'),
};

const bearer = (claims, extra = {}) => ({
  headers: { authorization: `Bearer ${jwt.sign(claims, process.env.JWT_SECRET)}` },
  params: {},
  body: {},
  ...extra,
});

async function runGuard(req) {
  const guard = createPlatformCompaniesGuard({ loadUser: async (userId) => CANDIDATES[userId] || null });
  const res = makeRes();
  let nextCalled = false;
  await guard(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

// ------------------------------------------------------------------ guard

test('companies guard: platform_owner and admin_network/admin of the active default company pass', async () => {
  for (const userId of [OWNER, id(1), id(2)]) {
    const result = await runGuard(bearer({ sub: userId, role: 'whatever' }));
    assert.equal(result.nextCalled, true, userId);
  }
});

test('companies guard: actor comes from the DB (platform owner flag only for platform_owner)', async () => {
  const owner = await runGuard(bearer({ sub: OWNER, role: 'platform_owner' }));
  assert.deepEqual(owner.req.platformActor, { id: OWNER, role: 'platform_owner', isPlatformOwner: true });
  assert.deepEqual(owner.req.tenant, { companyId: null, isPlatformOwner: true });

  const admin = await runGuard(bearer({ sub: id(1), role: 'platform_owner' }));
  assert.deepEqual(admin.req.platformActor, { id: id(1), role: 'admin_network', isPlatformOwner: false });
  assert.equal(admin.req.platformOwner, undefined, 'a company admin never becomes the platform owner');
});

test('companies guard: default-company admin_branch/manager/barber/super-manager are 403', async () => {
  for (const userId of [id(3), id(4), id(5), id(9)]) {
    const result = await runGuard(bearer({ sub: userId, role: 'admin_network' }));
    assert.equal(result.nextCalled, false, userId);
    assert.equal(result.res.statusCode, 403, userId);
    assert.equal(result.res.body.code, 'PLATFORM_OWNER_REQUIRED', userId);
  }
});

test('companies guard: another company\'s admin_network/admin is 403, as is a suspended default company', async () => {
  for (const userId of [id(6), id(7), id(8)]) {
    const result = await runGuard(bearer({ sub: userId, role: 'platform_owner' }));
    assert.equal(result.nextCalled, false, userId);
    assert.equal(result.res.statusCode, 403, userId);
    assert.equal(result.res.body.code, 'PLATFORM_OWNER_REQUIRED', userId);
  }
});

test('companies guard: no/invalid token, unknown account is 401; load failure is 500', async () => {
  assert.equal((await runGuard({ headers: {} })).res.statusCode, 401);
  assert.equal((await runGuard({ headers: { authorization: 'Bearer nope' } })).res.statusCode, 401);
  assert.equal((await runGuard(bearer({ sub: id(99), role: 'admin' }))).res.statusCode, 401);

  const failing = createPlatformCompaniesGuard({ loadUser: async () => { throw new Error('db down'); } });
  const res = makeRes();
  let nextCalled = false;
  await failing(bearer({ sub: OWNER }), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 500);
});

test('canManagePlatform: shared predicate of the companies and owners guards', () => {
  assert.equal(canManagePlatform(CANDIDATES[OWNER]), true);
  assert.equal(canManagePlatform(CANDIDATES[id(1)]), true);
  assert.equal(canManagePlatform({ ...CANDIDATES[id(2)], role: ' Admin ' }), true);
  for (const n of [3, 4, 5, 6, 7, 8, 9]) assert.equal(canManagePlatform(CANDIDATES[id(n)]), false, String(n));
  assert.equal(canManagePlatform({ role: 'platform_owner', company_id: DEFAULT_CO }), false);
  assert.equal(canManagePlatform(null), false);
});

test('router: every /companies route uses the companies guard', () => {
  const routes = platformRouter.stack.filter((entry) => entry.route).map((entry) => ({
    key: `${Object.keys(entry.route.methods)[0]} ${entry.route.path}`,
    guard: entry.route.stack[0].handle.name,
  }));
  const companyRoutes = routes.filter((route) => route.key.includes('/companies'));
  assert.equal(companyRoutes.length, 4);
  for (const route of companyRoutes) assert.equal(route.guard, 'requirePlatformCompaniesManager', route.key);
});

// --------------------------------------------------------------- handlers

function companiesRepo() {
  const companies = new Map([
    [DEFAULT_CO, { id: DEFAULT_CO, name: 'Bradobrey', code: 'BRADOBREY', status: 'active', is_default: true }],
    [OTHER_CO, { id: OTHER_CO, name: 'President', code: 'PRESIDENT', status: 'active', is_default: false }],
  ]);
  const users = [];
  return {
    companies,
    users,
    async tenantStrictSetting() { return 'on'; },
    async listCompanies() { return [...companies.values()]; },
    async findCompanyById(companyId) { return companies.get(companyId) || null; },
    async createCompany(fields) {
      const row = { id: id(40 + companies.size), status: 'active', is_default: false, ...fields };
      companies.set(row.id, row);
      return row;
    },
    async updateCompany(companyId, fields) {
      const row = companies.get(companyId);
      if (!row) return null;
      const next = { ...row, ...fields };
      companies.set(companyId, next);
      return next;
    },
    async loginTakenInCompany() { return false; },
    async createCompanyAdmin({ companyId, login }) {
      const row = { id: id(60 + users.length), login, role: 'admin', company_id: companyId };
      users.push(row);
      return row;
    },
  };
}

const adminActor = { id: id(1), role: 'admin_network', isPlatformOwner: false };
const ownerActor = { id: OWNER, role: 'platform_owner', isPlatformOwner: true };

function quietController(repo, logs = []) {
  return createPlatformController({ repo, env: { KIOSK_AUTH_ENFORCE: 'true' }, logAudit: (entry) => logs.push(entry) });
}

test('default-company admin_network can list, create and patch companies', async () => {
  const repo = companiesRepo();
  const logs = [];
  const controller = quietController(repo, logs);

  const listed = makeRes();
  await controller.listCompanies({ platformActor: adminActor }, listed);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.companies.length, 2);

  const created = makeRes();
  await controller.createCompany({ platformActor: adminActor, body: { name: 'Franchise', code: 'franchise' } }, created);
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.company.code, 'FRANCHISE');

  const suspended = makeRes();
  await controller.updateCompany({ platformActor: adminActor, params: { id: OTHER_CO }, body: { status: 'suspended' } }, suspended);
  assert.equal(suspended.statusCode, 200);
  assert.equal(suspended.body.company.status, 'suspended');

  const enrolled = makeRes();
  await controller.updateCompany({ platformActor: adminActor, params: { id: OTHER_CO }, body: { kiosk_enrollment_code: 'kiosk-code-123' } }, enrolled);
  assert.equal(enrolled.statusCode, 200);
  assert.equal(JSON.stringify(enrolled.body).includes('kiosk-code-123'), false);

  const admin = makeRes();
  await controller.createCompanyAdmin({ platformActor: adminActor, params: { id: OTHER_CO }, body: { login: 'boss', password: 'long-enough-1' } }, admin);
  assert.equal(admin.statusCode, 201);
  assert.equal(admin.body.user.company_id, OTHER_CO);

  assert.deepEqual(logs.map((entry) => entry.action), ['company.create', 'company.update', 'company.update', 'company.admin.create']);
  for (const entry of logs) {
    assert.equal(entry.actorId, id(1));
    assert.equal(entry.actorRole, 'admin_network');
  }
  assert.deepEqual(logs[2].fields, ['kiosk_enrollment_code_hash']);
  assert.equal(JSON.stringify(logs).includes('long-enough-1'), false, 'no secrets in the audit line');
});

test('default-company admin still cannot suspend the default company (409)', async () => {
  const controller = quietController(companiesRepo());
  const res = makeRes();
  await controller.updateCompany({ platformActor: adminActor, params: { id: DEFAULT_CO }, body: { status: 'suspended' } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'DEFAULT_COMPANY_SUSPEND_FORBIDDEN');
});

test('POST /companies/:id/admins for the default company: only the platform owner', async () => {
  const repo = companiesRepo();
  const controller = quietController(repo);
  const body = { login: 'second-admin', password: 'long-enough-1' };

  const refused = makeRes();
  await controller.createCompanyAdmin({ platformActor: adminActor, params: { id: DEFAULT_CO }, body }, refused);
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.body.code, 'DEFAULT_COMPANY_ADMIN_FORBIDDEN');

  const noActor = makeRes();
  await controller.createCompanyAdmin({ params: { id: DEFAULT_CO }, body }, noActor);
  assert.equal(noActor.statusCode, 403, 'fails closed without a guard-provided actor');
  assert.equal(repo.users.length, 0);

  const owner = makeRes();
  await controller.createCompanyAdmin({ platformActor: ownerActor, params: { id: DEFAULT_CO }, body }, owner);
  assert.equal(owner.statusCode, 201);
});

// ------------------------------------------------ GET /api/barbers/me flags

async function callMe({ user, company }) {
  const { installDbMock } = require('./helpers/tenantMocks');
  const barbers = require('../src/models/barbers');
  const mock = installDbMock({
    users: [{ data: user, error: null }],
    user_permissions: [{ data: [], error: null }],
    companies: [{ data: company, error: null }],
  });
  const res = makeRes();
  try {
    await barbers.me(bearer({ sub: user.id, role: user.role }, { query: {}, app: { get: () => null } }), res);
  } finally {
    mock.restore();
  }
  return { res, calls: mock.calls };
}

test('/api/barbers/me: can_manage_platform for an admin_network of the active default company', async () => {
  const { res, calls } = await callMe({
    user: { id: id(1), login: 'net', role: 'admin_network', branch_id: null, company_id: DEFAULT_CO },
    company: { is_default: true, status: 'active' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.company_is_default, true);
  assert.equal(res.body.user.can_manage_platform, true);
  assert.deepEqual(calls.filter((c) => c.table === 'companies' && c.method === 'eq').map((c) => c.args), [['id', DEFAULT_CO]]);
});

test('/api/barbers/me: false for another company admin and for a default-company admin_branch', async () => {
  const other = await callMe({
    user: { id: id(6), login: 'p', role: 'admin_network', branch_id: null, company_id: OTHER_CO },
    company: { is_default: false, status: 'active' },
  });
  assert.equal(other.res.body.user.can_manage_platform, false);
  assert.equal(other.res.body.user.company_is_default, false);

  const manager = await callMe({
    user: { id: id(3), login: 'b', role: 'admin_branch', branch_id: null, company_id: DEFAULT_CO },
    company: { is_default: true, status: 'active' },
  });
  assert.equal(manager.res.body.user.can_manage_platform, false);
  assert.equal(manager.res.body.user.company_is_default, true);
});

test('/api/barbers/me: a company lookup failure does not break /me (flag false)', async () => {
  const { res } = await callMe({
    user: { id: id(1), login: 'net', role: 'admin_network', branch_id: null, company_id: DEFAULT_CO },
    company: null,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.can_manage_platform, false);
});

// -------------------------------------------- global employeeAccess interplay

async function throughEmployeeAccess({ tokenRole, dbRole, companyId, path }) {
  const middleware = createEmployeeAccessMiddleware({
    loadState: async () => ({ user: { id: id(1), role: dbRole, company_id: companyId, company_status: 'active' }, barber: null }),
    validateSession: async () => ({ valid: true }),
  });
  const token = jwt.sign({ sub: id(1), role: tokenRole, companyId }, process.env.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: path, path };
  const res = makeRes();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('employeeAccess: a stale token role is rejected before the companies guard', async () => {
  const stale = await throughEmployeeAccess({ tokenRole: 'admin_network', dbRole: 'admin_branch', companyId: DEFAULT_CO, path: '/api/platform/companies' });
  assert.equal(stale.nextCalled, false);
  assert.equal(stale.res.statusCode, 401);
  assert.equal(stale.res.body.code, 'TOKEN_ROLE_STALE');

  const fresh = await throughEmployeeAccess({ tokenRole: 'admin_network', dbRole: 'admin_network', companyId: DEFAULT_CO, path: '/api/platform/companies' });
  assert.equal(fresh.nextCalled, true);
});

test('employeeAccess: platform_owner still has no tenant access', async () => {
  const owner = await throughEmployeeAccess({ tokenRole: 'platform_owner', dbRole: 'platform_owner', companyId: null, path: '/api/statistics/overview' });
  assert.equal(owner.res.statusCode, 403);
  assert.equal(owner.res.body.code, 'PLATFORM_OWNER_NO_TENANT_ACCESS');
});
