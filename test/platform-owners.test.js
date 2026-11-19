// Platform-owner account management:
//   GET  /api/platform/owners  -> { owners: [{ id, login, created_at }] }
//   POST /api/platform/owners  { login, password } -> 201 { owner: { id, login, created_at } }
// Allowed (DB-checked, never from the token): platform_owner, or
// admin_network/admin of the active DEFAULT company. Everyone else 403.
// The same audience manages /companies* (platform-default-admin.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'platform-owners-test-secret';

const {
  createPlatformController,
  createPlatformCompaniesGuard,
  createPlatformOwnersManagerGuard,
  platformRepo,
} = require('../src/models/platform');
const platformRouter = require('../src/routers/platform');
const { createEmployeeAccessMiddleware } = require('../src/middleware/employeeAccess');
const { installPoolMock, makeRes } = require('./helpers/tenantMocks');

const DEFAULT_CO = 'dddddddd-0000-4000-8000-00000000000d';
const OTHER_CO = 'eeeeeeee-0000-4000-8000-00000000000e';
const OWNER = '10000000-0000-4000-8000-0000000000f1';
const id = (n) => `20000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const bearer = (claims) => ({
  headers: { authorization: `Bearer ${jwt.sign(claims, process.env.JWT_SECRET)}` },
  params: {},
  body: {},
});

// ------------------------------------------------------------------ guard

const CANDIDATES = {
  [OWNER]: { id: OWNER, role: 'platform_owner', company_id: null, company_is_default: null, company_status: null },
  [id(1)]: { id: id(1), role: 'admin', company_id: DEFAULT_CO, company_is_default: true, company_status: 'active' },
  [id(2)]: { id: id(2), role: 'admin_network', company_id: DEFAULT_CO, company_is_default: true, company_status: 'active' },
  [id(3)]: { id: id(3), role: 'admin', company_id: OTHER_CO, company_is_default: false, company_status: 'active' },
  [id(4)]: { id: id(4), role: 'manager', company_id: DEFAULT_CO, company_is_default: true, company_status: 'active' },
  [id(5)]: { id: id(5), role: 'admin_branch', company_id: DEFAULT_CO, company_is_default: true, company_status: 'active' },
  [id(6)]: { id: id(6), role: 'admin', company_id: DEFAULT_CO, company_is_default: true, company_status: 'suspended' },
  [id(7)]: { id: id(7), role: ' Admin ', company_id: DEFAULT_CO, company_is_default: true, company_status: 'active' },
  [id(8)]: { id: id(8), role: 'super-manager', company_id: DEFAULT_CO, company_is_default: true, company_status: 'active' },
};

async function runGuard(req) {
  const guard = createPlatformOwnersManagerGuard({ loadUser: async (userId) => CANDIDATES[userId] || null });
  const res = makeRes();
  let nextCalled = false;
  await guard(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

test('owners guard: platform_owner and admin/admin_network of the active default company pass', async () => {
  for (const userId of [OWNER, id(1), id(2), id(7)]) {
    const result = await runGuard(bearer({ sub: userId, role: 'whatever' }));
    assert.equal(result.nextCalled, true, userId);
  }
});

test('owners guard: everyone else is 403 (DB role and company decide, not the token)', async () => {
  for (const userId of [id(3), id(4), id(5), id(6), id(8)]) {
    const result = await runGuard(bearer({ sub: userId, role: 'platform_owner' }));
    assert.equal(result.nextCalled, false, userId);
    assert.equal(result.res.statusCode, 403, userId);
    assert.equal(result.res.body.code, 'PLATFORM_OWNERS_FORBIDDEN', userId);
  }
});

test('owners guard: no/invalid token or unknown account is 401', async () => {
  assert.equal((await runGuard({ headers: {} })).res.statusCode, 401);
  assert.equal((await runGuard({ headers: { authorization: 'Bearer nope' } })).res.statusCode, 401);
  assert.equal((await runGuard(bearer({ sub: id(99), role: 'admin' }))).res.statusCode, 401);
  assert.equal((await runGuard(bearer({ sub: 'not-a-uuid', role: 'admin' }))).res.statusCode, 401);
});

test('owners guard: a load failure is 500, not a pass', async () => {
  const guard = createPlatformOwnersManagerGuard({ loadUser: async () => { throw new Error('db down'); } });
  const res = makeRes();
  let nextCalled = false;
  await guard(bearer({ sub: OWNER, role: 'platform_owner' }), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 500);
});

test('companies guard has the same audience as the owners guard (MULTI_TENANCY 12)', async () => {
  const guard = createPlatformCompaniesGuard({ loadUser: async (userId) => CANDIDATES[userId] || null });
  for (const [userId, allowed] of [[OWNER, true], [id(1), true], [id(2), true], [id(3), false], [id(4), false], [id(6), false]]) {
    const res = makeRes();
    let nextCalled = false;
    await guard(bearer({ sub: userId, role: 'admin' }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, allowed, userId);
    if (!allowed) assert.equal(res.body.code, 'PLATFORM_OWNER_REQUIRED', userId);
  }
});

// ----------------------------------------------------------------- router

test('router: /owners uses the owners guard; every /companies route uses the companies guard', () => {
  const routes = platformRouter.stack.filter((entry) => entry.route).map((entry) => ({
    key: `${Object.keys(entry.route.methods)[0]} ${entry.route.path}`,
    guard: entry.route.stack[0].handle.name,
  }));
  const owners = routes.filter((route) => route.key.endsWith(' /owners'));
  assert.deepEqual(owners.map((route) => route.key).sort(), ['get /owners', 'post /owners']);
  for (const route of owners) assert.equal(route.guard, 'requirePlatformOwnersManager', route.key);
  for (const route of routes.filter((r) => r.key.includes('/companies'))) {
    assert.equal(route.guard, 'requirePlatformCompaniesManager', route.key);
  }
});

// -------------------------------------------------------------- handlers

function ownersRepo() {
  const owners = [{ id: OWNER, login: 'root', created_at: '2026-11-18T10:00:00.000Z', password_hash: 'x' }];
  return {
    owners,
    async listPlatformOwners() { return owners.map(({ password_hash: _h, ...row }) => row); },
    async platformOwnerLoginTaken(login) { return owners.some((row) => row.login === login); },
    async createPlatformOwner({ login, passwordHash }) {
      const row = { id: id(50 + owners.length), login, created_at: '2026-11-19T10:00:00.000Z', password_hash: passwordHash };
      owners.push(row);
      return { id: row.id, login: row.login, created_at: row.created_at };
    },
  };
}

test('owners: list returns id, login, created_at only', async () => {
  const controller = createPlatformController({ repo: ownersRepo() });
  const res = makeRes();
  await controller.listOwners({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { owners: [{ id: OWNER, login: 'root', created_at: '2026-11-18T10:00:00.000Z' }] });
});

test('owners: create hashes the password with bcrypt and returns the owner', async () => {
  const repo = ownersRepo();
  const controller = createPlatformController({ repo });
  const res = makeRes();
  await controller.createOwner({ body: { login: ' second ', password: 'long-enough-1' } }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(Object.keys(res.body.owner).sort(), ['created_at', 'id', 'login']);
  assert.equal(res.body.owner.login, 'second');
  const stored = repo.owners.find((row) => row.login === 'second');
  assert.ok(bcrypt.compareSync('long-enough-1', stored.password_hash));
  assert.equal(bcrypt.getRounds(stored.password_hash), 10, 'same cost as createCompanyAdmin');
  assert.equal(JSON.stringify(res.body).includes('password'), false);
});

test('owners: 409 LOGIN_TAKEN for an existing platform_owner login (pre-check and unique race)', async () => {
  const repo = ownersRepo();
  const controller = createPlatformController({ repo });
  const taken = makeRes();
  await controller.createOwner({ body: { login: 'root', password: 'long-enough-1' } }, taken);
  assert.equal(taken.statusCode, 409);
  assert.equal(taken.body.code, 'LOGIN_TAKEN');

  const raceRepo = { ...ownersRepo(), async createPlatformOwner() { const e = new Error('dup'); e.code = '23505'; throw e; } };
  const race = makeRes();
  await createPlatformController({ repo: raceRepo }).createOwner({ body: { login: 'fresh', password: 'long-enough-1' } }, race);
  assert.equal(race.statusCode, 409);
  assert.equal(race.body.code, 'LOGIN_TAKEN');
});

test('owners: 400 for an empty login or a password shorter than 8', async () => {
  const controller = createPlatformController({ repo: ownersRepo() });
  for (const body of [{ login: '', password: 'long-enough-1' }, { login: '  ', password: 'long-enough-1' }, { password: 'long-enough-1' },
    { login: 'ok', password: 'short77' }, { login: 'ok' }, { login: 'has space', password: 'long-enough-1' }]) {
    const res = makeRes();
    await controller.createOwner({ body }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
});

// ------------------------------------------------------------------ repo SQL

test('repo: createPlatformOwner inserts role platform_owner with company_id NULL', async () => {
  const mock = installPoolMock((sql) => (/^\s*insert into users/i.test(sql)
    ? { rows: [{ id: id(60), login: 'new', created_at: '2026-11-19T00:00:00Z' }] }
    : { rows: [] }));
  try {
    const owner = await platformRepo.createPlatformOwner({ login: 'new', passwordHash: 'h' });
    assert.deepEqual(owner, { id: id(60), login: 'new', created_at: '2026-11-19T00:00:00Z' });
  } finally {
    mock.restore();
  }
  const insert = mock.calls.find((call) => /insert into users/i.test(call.sql));
  assert.match(insert.sql, /'platform_owner'/);
  assert.match(insert.sql, /company_id[\s\S]*null/i);
  assert.deepEqual(insert.params, ['new', 'h']);
});

test('repo: owner lookups are limited to platform_owner rows without company', async () => {
  const mock = installPoolMock(() => ({ rows: [], rowCount: 0 }));
  try {
    await platformRepo.listPlatformOwners();
    await platformRepo.platformOwnerLoginTaken('x');
  } finally {
    mock.restore();
  }
  for (const call of mock.calls) {
    assert.match(call.sql, /role = 'platform_owner'/);
    assert.match(call.sql, /company_id is null/);
  }
});

test('repo: owners list and create work before migration 009 (created_at null)', async () => {
  const missing = Object.assign(new Error('column "created_at" does not exist'), { code: '42703' });
  const mock = installPoolMock((sql) => {
    if (/created_at/.test(sql) && !/null as created_at/.test(sql)) throw missing;
    if (/^\s*insert/i.test(sql)) return { rows: [{ id: id(61), login: 'new', created_at: null }] };
    return { rows: [{ id: OWNER, login: 'root', created_at: null }] };
  });
  try {
    assert.deepEqual(await platformRepo.listPlatformOwners(), [{ id: OWNER, login: 'root', created_at: null }]);
    assert.deepEqual(await platformRepo.createPlatformOwner({ login: 'new', passwordHash: 'h' }), { id: id(61), login: 'new', created_at: null });
  } finally {
    mock.restore();
  }
});

test('repo: owners-manager lookup joins the company default flag and status', async () => {
  const mock = installPoolMock(() => ({ rows: [{ id: id(1), role: 'admin', company_id: DEFAULT_CO, company_is_default: true, company_status: 'active' }] }));
  try {
    const row = await platformRepo.findOwnersManagerCandidate(id(1));
    assert.equal(row.company_is_default, true);
  } finally {
    mock.restore();
  }
  assert.match(mock.calls[0].sql, /left join companies/i);
  assert.deepEqual(mock.calls[0].params, [id(1)]);
});

// -------------------------------------------- global employeeAccess interplay

async function throughEmployeeAccess({ role, companyId, path }) {
  const middleware = createEmployeeAccessMiddleware({
    loadState: async () => ({ user: { id: id(1), role, company_id: companyId, company_status: companyId ? 'active' : null }, barber: null }),
    validateSession: async () => ({ valid: true }),
  });
  const token = jwt.sign({ sub: id(1), role, companyId }, process.env.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: path, path };
  const res = makeRes();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('employeeAccess: a default-company admin reaches /api/platform/owners; platform_owner stays off tenant routes', async () => {
  const admin = await throughEmployeeAccess({ role: 'admin', companyId: DEFAULT_CO, path: '/api/platform/owners' });
  assert.equal(admin.nextCalled, true);

  const owner = await throughEmployeeAccess({ role: 'platform_owner', companyId: null, path: '/api/branches' });
  assert.equal(owner.nextCalled, false);
  assert.equal(owner.res.statusCode, 403);
  assert.equal(owner.res.body.code, 'PLATFORM_OWNER_NO_TENANT_ACCESS');

  const ownerOnPlatform = await throughEmployeeAccess({ role: 'platform_owner', companyId: null, path: '/api/platform/owners' });
  assert.equal(ownerOnPlatform.nextCalled, true);
});
