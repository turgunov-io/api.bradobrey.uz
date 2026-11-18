// Per-company kiosk enrollment codes (security review H1).
//
// POST /api/kiosk/register needs company_code + that company's own enrollment
// code (companies.kiosk_enrollment_code_hash), or a staff bearer of the same
// company. The platform-wide env KIOSK_ENROLLMENT_CODE is only a legacy
// fallback for the default company while it is the only company.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'kiosk-company-enrollment-secret';

const { createKioskRegistry } = require('../src/services/kioskRegistration');
const {
  enrollmentCodeMatches,
  hashEnrollmentCode,
  validateEnrollmentCode,
} = require('../src/utils/kioskEnrollmentCode');
const { createPlatformController, validateCompanyFields } = require('../src/models/platform');
const { createKioskEnrollmentController } = require('../src/models/kioskEnrollment');
const kioskRouter = require('../src/routers/kiosk');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const STAFF_A = '10000000-0000-4000-8000-00000000000a';
const STAFF_B = '10000000-0000-4000-8000-00000000000b';
const DEVICE = 'Lenovo Tab [01]';
const CODE_A = 'bradobrey-kiosk-2026';
const CODE_B = 'president-kiosk-2026';

const BRADOBREY = { id: COMPANY_A, code: 'BRADOBREY', status: 'active', is_default: true };
const PRESIDENT = { id: COMPANY_B, code: 'PRESIDENT', status: 'active', is_default: false };
const BRANCHES = {
  [BRANCH_A1]: { id: BRANCH_A1, company_id: COMPANY_A, is_active: true },
  [BRANCH_B1]: { id: BRANCH_B1, company_id: COMPANY_B, is_active: true },
};

function companiesRepo({ list, hashes = {} }) {
  return {
    async findActiveByCode(code) {
      return list.find((row) => row.code.toLowerCase() === String(code).toLowerCase() && row.status === 'active') || null;
    },
    async findDefault() { return list.find((row) => row.is_default) || null; },
    async countCompanies() { return list.length; },
    async findBranch(id) { return BRANCHES[id] || null; },
    async findKioskEnrollmentHash(companyId) { return hashes[companyId] || null; },
  };
}

function kioskRepo() {
  const rows = [];
  return {
    rows,
    async branchExists(id) { return Boolean(BRANCHES[id]); },
    async saveKiosk({ branchId, deviceName, tokenHash }) {
      const row = { id: `k${rows.length + 1}`, branch_id: branchId, device_name: deviceName, device_token_hash: tokenHash };
      rows.push(row);
      return row;
    },
  };
}

const ACTORS = {
  [STAFF_A]: { id: STAFF_A, role: 'admin', branchScope: [BRANCH_A1], companyId: COMPANY_A },
  [STAFF_B]: { id: STAFF_B, role: 'admin', branchScope: [BRANCH_B1], companyId: COMPANY_B },
};

const registry = ({ list = [BRADOBREY, PRESIDENT], hashes = {}, env = '', warnings = [] } = {}) => createKioskRegistry({
  repo: kioskRepo(),
  companies: companiesRepo({ list, hashes }),
  enrollmentCode: () => env,
  loadActor: async (claims) => ACTORS[claims?.sub] || null,
  warn: (msg) => warnings.push(msg),
});

const register = (reg, extra) => reg.register({ branchId: BRANCH_A1, deviceName: DEVICE, ...extra });

// ------------------------------------------------------------ hashing util

test('enrollment codes are validated, stored as a SHA-256 hex hash and compared exactly', () => {
  assert.deepEqual(validateEnrollmentCode('  long-enough-code '), ['long-enough-code']);
  for (const bad of ['short', '', '   ', null, 42, 'x'.repeat(129)]) {
    assert.ok(validateEnrollmentCode(bad)[1], String(bad));
  }
  const hash = hashEnrollmentCode(CODE_A);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, CODE_A);
  assert.equal(enrollmentCodeMatches(CODE_A, hash), true);
  assert.equal(enrollmentCodeMatches(` ${CODE_A} `, hash), true, 'surrounding spaces are ignored like on save');
  assert.equal(enrollmentCodeMatches(CODE_B, hash), false);
  assert.equal(enrollmentCodeMatches(undefined, hash), false);
  assert.equal(enrollmentCodeMatches(CODE_A, null), false);
  assert.equal(enrollmentCodeMatches(CODE_A, 'not-hex'), false);
});

// --------------------------------------------------------------- registry

test('H1: company B code cannot enroll a kiosk into company A (per-company codes)', async () => {
  const hashes = { [COMPANY_A]: hashEnrollmentCode(CODE_A), [COMPANY_B]: hashEnrollmentCode(CODE_B) };
  const reg = registry({ hashes });

  const foreignCode = await register(reg, { companyCode: 'BRADOBREY', enrollmentCode: CODE_B });
  assert.equal(foreignCode.status, 403);
  assert.equal(foreignCode.body.code, 'KIOSK_ENROLLMENT_CODE_INVALID');

  const own = await register(reg, { companyCode: 'BRADOBREY', enrollmentCode: CODE_A });
  assert.equal(own.status, 201);
  const ownB = await reg.register({ companyCode: 'PRESIDENT', branchId: BRANCH_B1, deviceName: DEVICE, enrollmentCode: CODE_B });
  assert.equal(ownB.status, 201);
});

test('H1: the env code is ignored once 2+ companies exist; a company without its own code is staff-only', async () => {
  const reg = registry({ env: 'legacy-env-code', hashes: { [COMPANY_B]: hashEnrollmentCode(CODE_B) } });
  const envCode = await register(reg, { companyCode: 'BRADOBREY', enrollmentCode: 'legacy-env-code' });
  assert.equal(envCode.status, 403);
  const noCode = await register(reg, { companyCode: 'BRADOBREY' });
  assert.equal(noCode.status, 403, 'no open enrollment with 2+ companies even when env is unset');

  const openReg = registry({ env: '' });
  assert.equal((await register(openReg, { companyCode: 'BRADOBREY' })).status, 403);

  const staff = await register(openReg, { companyCode: 'BRADOBREY', actorClaims: { sub: STAFF_A } });
  assert.equal(staff.status, 201);
  const foreignStaff = await register(openReg, { companyCode: 'BRADOBREY', actorClaims: { sub: STAFF_B } });
  assert.equal(foreignStaff.status, 403);
});

test('H1: env KIOSK_ENROLLMENT_CODE stays a legacy fallback for the only (default) company', async () => {
  const single = registry({ list: [BRADOBREY], env: 'legacy-env-code' });
  assert.equal((await register(single, { companyCode: 'BRADOBREY', enrollmentCode: 'legacy-env-code' })).status, 201);
  assert.equal((await register(single, { enrollmentCode: 'legacy-env-code', deviceName: 'legacy app' })).status, 201);
  assert.equal((await register(single, { companyCode: 'BRADOBREY', deviceName: 'x', enrollmentCode: 'wrong-code' })).status, 403);

  // Unset env + single company: the old open behaviour (with a warning).
  const warnings = [];
  const open = registry({ list: [BRADOBREY], warnings });
  assert.equal((await register(open, { companyCode: 'BRADOBREY' })).status, 201);
  assert.ok(warnings.some((msg) => msg.includes('KIOSK_ENROLLMENT_CODE')));
});

test('H1: once the only company has its own code, the env code no longer works for it', async () => {
  const reg = registry({ list: [BRADOBREY], env: 'legacy-env-code', hashes: { [COMPANY_A]: hashEnrollmentCode(CODE_A) } });
  assert.equal((await register(reg, { companyCode: 'BRADOBREY', enrollmentCode: 'legacy-env-code' })).status, 403);
  assert.equal((await register(reg, { companyCode: 'BRADOBREY', enrollmentCode: CODE_A })).status, 201);
});

test('H1: a non-default company is never covered by the env code, even as the only company', async () => {
  const lone = { ...PRESIDENT };
  const reg = registry({ list: [lone], env: 'legacy-env-code' });
  const result = await reg.register({ companyCode: 'PRESIDENT', branchId: BRANCH_B1, deviceName: DEVICE, enrollmentCode: 'legacy-env-code' });
  assert.equal(result.status, 403);
});

// ------------------------------------------- platform owner: set / rotate

function platformRepo(company) {
  const updates = [];
  return {
    updates,
    async findCompanyById(id) { return id === company.id ? { ...company } : null; },
    async updateCompany(id, fields) { updates.push({ id, fields }); return { ...company, ...fields, kiosk_enrollment_code_hash: undefined }; },
    async tenantStrictSetting() { return 'on'; },
  };
}

function res() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

test('platform PATCH accepts kiosk_enrollment_code, stores only its hash and never returns it', async () => {
  assert.equal(validateCompanyFields({ kiosk_enrollment_code: 'short' }, { partial: true }).error !== undefined, true);
  assert.ok(validateCompanyFields({ kiosk_enrollment_code: CODE_A }).error, 'not accepted on create');

  const repo = platformRepo({ id: COMPANY_B, is_default: false, status: 'active' });
  const controller = createPlatformController({ repo, env: { KIOSK_AUTH_ENFORCE: 'true' } });
  const response = res();
  await controller.updateCompany({ params: { id: COMPANY_B }, body: { kiosk_enrollment_code: ` ${CODE_B} ` } }, response);

  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.deepEqual(repo.updates[0].fields, { kiosk_enrollment_code_hash: hashEnrollmentCode(CODE_B) });
  const serialized = JSON.stringify(response.body);
  assert.ok(!serialized.includes(CODE_B), 'plain code never returned');
  assert.ok(!serialized.includes(hashEnrollmentCode(CODE_B)), 'hash never returned');
});

test('platform PATCH kiosk_enrollment_code: null clears the company code', async () => {
  const repo = platformRepo({ id: COMPANY_B, is_default: false, status: 'active' });
  const controller = createPlatformController({ repo, env: {} });
  const response = res();
  await controller.updateCompany({ params: { id: COMPANY_B }, body: { kiosk_enrollment_code: null } }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(repo.updates[0].fields, { kiosk_enrollment_code_hash: null });
});

// ------------------------------------------- company admin: rotate own code

function enrollmentRepo() {
  const saved = [];
  return { saved, async setKioskEnrollmentHash(companyId, hash) { saved.push({ companyId, hash }); return true; } };
}

const staffReq = (role, companyId, body) => ({
  staffAccess: { role, actor: { id: STAFF_A, role, company_id: companyId } },
  tenant: { companyId, isPlatformOwner: false },
  body,
});

test('company network admins rotate their own company code (hash stored, code not echoed)', async () => {
  const repo = enrollmentRepo();
  const controller = createKioskEnrollmentController({ repo });
  const response = res();
  await controller.rotate(staffReq('admin', COMPANY_A, { enrollment_code: CODE_A }), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(repo.saved, [{ companyId: COMPANY_A, hash: hashEnrollmentCode(CODE_A) }]);
  assert.deepEqual(response.body, { updated: true });
});

test('branch roles, a missing company and invalid codes cannot rotate the company code', async () => {
  const repo = enrollmentRepo();
  const controller = createKioskEnrollmentController({ repo });

  const manager = res();
  await controller.rotate(staffReq('manager', COMPANY_A, { enrollment_code: CODE_A }), manager);
  assert.equal(manager.statusCode, 403);

  const noCompany = res();
  await controller.rotate({ ...staffReq('admin', null, { enrollment_code: CODE_A }), tenant: { companyId: null } }, noCompany);
  assert.equal(noCompany.statusCode, 403);

  const invalid = res();
  await controller.rotate(staffReq('admin', COMPANY_A, { enrollment_code: 'short' }), invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(repo.saved.length, 0);
});

test('PUT /api/kiosk/enrollment-code is guarded by DB-checked staff access', () => {
  const layer = kioskRouter.stack.find((entry) => entry.route?.path === '/enrollment-code');
  assert.ok(layer, 'route exists');
  assert.ok(layer.route.methods.put);
  assert.equal(layer.route.stack.length, 2, 'staff guard + handler');
});
