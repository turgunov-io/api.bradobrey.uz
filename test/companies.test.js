// Company code entry (POST /api/companies/resolve), platform-owner company
// management (/api/platform/*) and login by company code — MULTI_TENANCY
// Phase 1 step B1.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'companies-test-secret';

const { createCompaniesController } = require('../src/models/companies');
const { createPlatformController, createPlatformOwnerGuard, validateCompanyFields } = require('../src/models/platform');
const { resolveLoginCompany } = require('../src/utils/tenant');
const companiesRouter = require('../src/routers/companies');
const platformRouter = require('../src/routers/platform');
const { COMPANY_RESOLVE_RATE_LIMIT } = require('../src/routers/companies');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OWNER_ID = '10000000-0000-4000-8000-0000000000ff';
const ADMIN_ID = '10000000-0000-4000-8000-00000000000a';

function res() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const PUBLIC_A = { id: COMPANY_A, name: 'Bradobrey', code: 'BRADOBREY', logo_url: null, primary_color: '#112233', currency: 'UZS' };

function resolveRepo() {
  const calls = [];
  return {
    calls,
    async findActiveByCode(code) {
      calls.push(code);
      return code.toLowerCase() === 'bradobrey' ? { ...PUBLIC_A, status: 'active', timezone: 'Asia/Tashkent', is_default: true } : null;
    },
    async listActiveBranches(companyId) {
      return companyId === COMPANY_A ? [{ id: 'b1', name: 'Chilonzor', address: 'Street 1' }] : [];
    },
  };
}

// --------------------------------------------------------------- resolve

test('resolve returns the public company card and its active branches (trimmed, case-insensitive)', async () => {
  const repo = resolveRepo();
  const controller = createCompaniesController({ repo });
  const response = res();
  await controller.resolve({ body: { code: '  bradobrey ' } }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { company: PUBLIC_A, branches: [{ id: 'b1', name: 'Chilonzor', address: 'Street 1' }] });
  assert.deepEqual(repo.calls, ['bradobrey']);
});

test('resolve answers the same 404 for unknown, suspended and malformed codes', async () => {
  const controller = createCompaniesController({ repo: resolveRepo() });
  const bodies = [];
  for (const code of ['NOPE', 'SUSPENDEDCO', 'has spaces', 'x', 12345]) {
    const response = res();
    await controller.resolve({ body: { code } }, response);
    assert.equal(response.statusCode, 404, String(code));
    bodies.push(JSON.stringify(response.body));
  }
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(JSON.parse(bodies[0]), { code: 'COMPANY_NOT_FOUND', error: 'Company not found' });
});

test('resolve requires a code', async () => {
  const controller = createCompaniesController({ repo: resolveRepo() });
  const response = res();
  await controller.resolve({ body: {} }, response);
  assert.equal(response.statusCode, 400);
});

test('resolve is rate-limited per IP and needs no auth', () => {
  const layer = companiesRouter.stack.find((entry) => entry.route?.path === '/resolve');
  assert.ok(layer.route.methods.post);
  assert.equal(layer.route.stack.length, 2, 'rate limiter + handler');
  assert.equal(COMPANY_RESOLVE_RATE_LIMIT.keyBy, 'ip');
});

// ------------------------------------------------------- login by company

test('resolveLoginCompany: code -> active company, unknown/suspended -> 404', async () => {
  const warnings = [];
  const repo = { ...resolveRepo(), async findDefault() { return { id: COMPANY_A, status: 'active' }; } };
  assert.equal((await resolveLoginCompany(' Bradobrey', { repo, warn: (m) => warnings.push(m) })).company.id, COMPANY_A);
  const missing = await resolveLoginCompany('NOPE', { repo });
  assert.equal(missing.error.status, 404);
  assert.equal(missing.error.body.code, 'COMPANY_NOT_FOUND');
});

test('resolveLoginCompany: no code -> 400 COMPANY_CODE_REQUIRED once 2+ companies exist (M4)', async () => {
  const repo = {
    ...resolveRepo(),
    async findDefault() { return { id: COMPANY_A, status: 'active' }; },
    async countCompanies() { return 2; },
  };
  for (const code of [undefined, null, '']) {
    const result = await resolveLoginCompany(code, { repo, warn: () => {} });
    assert.equal(result.error?.status, 400);
    assert.equal(result.error.body.code, 'COMPANY_CODE_REQUIRED');
  }
});

test('resolveLoginCompany: no code -> default company with a warning while it is the only company', async () => {
  const warnings = [];
  const repo = {
    ...resolveRepo(),
    async findDefault() { return { id: COMPANY_A, status: 'active' }; },
    async countCompanies() { return 1; },
  };
  const result = await resolveLoginCompany(undefined, { repo, warn: (m) => warnings.push(m) });
  assert.equal(result.company.id, COMPANY_A);
  assert.equal(result.legacy, true);
  assert.equal(warnings.length, 1);

  const none = await resolveLoginCompany('', { repo: { ...repo, async findDefault() { return null; } }, warn: () => {} });
  assert.equal(none.error.status, 400);
  assert.equal(none.error.body.code, 'COMPANY_CODE_REQUIRED');

  const suspended = await resolveLoginCompany(null, { repo: { ...repo, async findDefault() { return { id: COMPANY_A, status: 'suspended' }; } }, warn: () => {} });
  assert.equal(suspended.error.status, 403);
  assert.equal(suspended.error.body.code, 'COMPANY_SUSPENDED');
});

// ----------------------------------------------------- platform: guard

const bearer = (claims) => ({ headers: { authorization: `Bearer ${jwt.sign(claims, process.env.JWT_SECRET)}` }, params: {}, body: {} });

test('platform guard admits only a DB platform_owner without company', async () => {
  const users = {
    [OWNER_ID]: { id: OWNER_ID, role: 'platform_owner', company_id: null },
    [ADMIN_ID]: { id: ADMIN_ID, role: 'admin', company_id: COMPANY_A },
  };
  const guard = createPlatformOwnerGuard({ loadUser: async (id) => users[id] || null });
  const run = async (req) => { const response = res(); let next = false; await guard(req, response, () => { next = true; }); return { response, next }; };

  assert.equal((await run({ headers: {} })).response.statusCode, 401);
  assert.equal((await run(bearer({ sub: OWNER_ID, role: 'platform_owner' }))).next, true);
  // Token role is irrelevant: the DB says admin.
  const admin = await run(bearer({ sub: ADMIN_ID, role: 'platform_owner' }));
  assert.equal(admin.response.statusCode, 403);
  assert.equal(admin.response.body.code, 'PLATFORM_OWNER_REQUIRED');
  assert.equal((await run(bearer({ sub: OWNER_ID, role: 'marketplace' }))).response.statusCode, 401);
});

test('every platform company route is behind the platform-owner guard; login is rate-limited', () => {
  const routes = platformRouter.stack.filter((entry) => entry.route).map((entry) => ({
    path: entry.route.path,
    methods: Object.keys(entry.route.methods),
    names: entry.route.stack.map((layer) => layer.handle.name),
  }));
  const companyRoutes = routes.filter((route) => route.path.startsWith('/companies'));
  assert.deepEqual(
    companyRoutes.map((route) => `${route.methods[0]} ${route.path}`).sort(),
    ['get /companies', 'patch /companies/:id', 'post /companies', 'post /companies/:id/admins'],
  );
  for (const route of companyRoutes) assert.equal(route.names[0], 'requirePlatformOwner', route.path);
  const login = routes.find((route) => route.path === '/login');
  assert.equal(login.names.length, 2);
});

// ------------------------------------------------- platform: validation

test('validateCompanyFields normalizes and validates company fields', () => {
  assert.deepEqual(
    validateCompanyFields({ name: ' President ', code: 'president', currency: 'uzs', primary_color: '#AABBCC', logo_url: 'https://cdn.example.com/a.png', timezone: 'Asia/Tashkent' }),
    { fields: { name: 'President', code: 'PRESIDENT', currency: 'UZS', primary_color: '#AABBCC', logo_url: 'https://cdn.example.com/a.png', timezone: 'Asia/Tashkent' } },
  );
  assert.ok(validateCompanyFields({ code: 'X' }).error, 'name required on create');
  assert.ok(validateCompanyFields({ name: 'A', code: 'bad code' }).error);
  assert.ok(validateCompanyFields({ name: 'A', code: 'GOOD', primary_color: 'red' }).error);
  assert.ok(validateCompanyFields({ name: 'A', code: 'GOOD', logo_url: 'javascript:alert(1)' }).error);
  assert.ok(validateCompanyFields({ name: 'A', code: 'GOOD', timezone: 'Mars/Base' }).error);
  assert.ok(validateCompanyFields({ name: 'A', code: 'GOOD', is_default: true }).error, 'unknown fields rejected');
  assert.ok(validateCompanyFields({ name: 'A', code: 'GOOD', status: 'suspended' }).error, 'status only on update');
  assert.deepEqual(validateCompanyFields({ status: 'suspended' }, { partial: true }), { fields: { status: 'suspended' } });
  assert.ok(validateCompanyFields({}, { partial: true }).error, 'empty patch');
  assert.deepEqual(validateCompanyFields({ logo_url: null }, { partial: true }), { fields: { logo_url: null } });
});

// ------------------------------------------------- platform: handlers

function platformRepo() {
  const companies = new Map([[COMPANY_A, { id: COMPANY_A, name: 'Bradobrey', code: 'BRADOBREY', status: 'active', is_default: true }]]);
  const users = [];
  return {
    companies,
    users,
    async tenantStrictSetting() { return 'on'; },
    async listCompanies() { return [...companies.values()]; },
    async findCompanyById(id) { return companies.get(id) || null; },
    async createCompany(fields) {
      if ([...companies.values()].some((row) => row.code.toLowerCase() === fields.code.toLowerCase())) {
        const error = new Error('duplicate'); error.code = '23505'; throw error;
      }
      const row = { id: `00000000-0000-4000-8000-00000000000${companies.size + 1}`, status: 'active', is_default: false, ...fields };
      companies.set(row.id, row);
      return row;
    },
    async updateCompany(id, fields) {
      const row = companies.get(id);
      if (!row) return null;
      const next = { ...row, ...fields };
      companies.set(id, next);
      return next;
    },
    async loginTakenInCompany(companyId, login) { return users.some((user) => user.company_id === companyId && user.login === login); },
    async createCompanyAdmin({ companyId, login, passwordHash }) {
      const row = { id: `u${users.length + 1}`, login, role: 'admin', company_id: companyId, password_hash: passwordHash };
      users.push(row);
      return { id: row.id, login, role: 'admin', company_id: companyId };
    },
    async findPlatformOwnerByLogin(login) {
      return login === 'owner' ? { id: OWNER_ID, login: 'owner', role: 'platform_owner', company_id: null, password_hash: bcrypt.hashSync('owner-pass', 4) } : null;
    },
  };
}

test('platform: create, list and patch companies (no stats, no client data)', async () => {
  const repo = platformRepo();
  const controller = createPlatformController({ repo, env: { KIOSK_AUTH_ENFORCE: 'true' } });

  const created = res();
  await controller.createCompany({ body: { name: 'President', code: 'president' } }, created);
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.company.code, 'PRESIDENT');

  const duplicate = res();
  await controller.createCompany({ body: { name: 'Again', code: 'PRESIDENT' } }, duplicate);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.body.code, 'COMPANY_CODE_TAKEN');

  const listed = res();
  await controller.listCompanies({}, listed);
  assert.equal(listed.body.companies.length, 2);

  const suspended = res();
  await controller.updateCompany({ params: { id: created.body.company.id }, body: { status: 'suspended' } }, suspended);
  assert.equal(suspended.statusCode, 200);
  assert.equal(suspended.body.company.status, 'suspended');

  const missing = res();
  await controller.updateCompany({ params: { id: 'nope' }, body: { name: 'X' } }, missing);
  assert.equal(missing.statusCode, 404);
});

test('platform: the default company cannot be suspended', async () => {
  const controller = createPlatformController({ repo: platformRepo() });
  const response = res();
  await controller.updateCompany({ params: { id: COMPANY_A }, body: { status: 'suspended' } }, response);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'DEFAULT_COMPANY_SUSPEND_FORBIDDEN');
});

test('platform: create the first admin of a company with a bcrypt-hashed password', async () => {
  const repo = platformRepo();
  const controller = createPlatformController({ repo, env: { KIOSK_AUTH_ENFORCE: 'true' } });

  const created = res();
  await controller.createCompanyAdmin({ params: { id: COMPANY_A }, body: { login: 'boss', password: 'long-enough-1' } }, created);
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.body.user, { id: 'u1', login: 'boss', role: 'admin', company_id: COMPANY_A });
  assert.ok(bcrypt.compareSync('long-enough-1', repo.users[0].password_hash));
  assert.equal(JSON.stringify(created.body).includes('password'), false);

  const again = res();
  await controller.createCompanyAdmin({ params: { id: COMPANY_A }, body: { login: 'boss', password: 'long-enough-1' } }, again);
  assert.equal(again.statusCode, 409);

  const weak = res();
  await controller.createCompanyAdmin({ params: { id: COMPANY_A }, body: { login: 'boss2', password: 'short' } }, weak);
  assert.equal(weak.statusCode, 400);

  const noCompany = res();
  await controller.createCompanyAdmin({ params: { id: 'nope' }, body: { login: 'x1', password: 'long-enough-1' } }, noCompany);
  assert.equal(noCompany.statusCode, 404);
});

test('platform: owner login issues a platform_owner token without company', async () => {
  const controller = createPlatformController({ repo: platformRepo() });
  const ok = res();
  await controller.login({ body: { login: 'owner', password: 'owner-pass' } }, ok);
  assert.equal(ok.statusCode, 200);
  const claims = jwt.verify(ok.body.token, process.env.JWT_SECRET);
  assert.equal(claims.role, 'platform_owner');
  assert.equal(claims.sub, OWNER_ID);
  assert.equal(claims.companyId, null);

  for (const body of [{ login: 'owner', password: 'wrong' }, { login: 'nobody', password: 'x' }, {}]) {
    const response = res();
    await controller.login({ body }, response);
    assert.equal(response.statusCode, 400);
  }
});
