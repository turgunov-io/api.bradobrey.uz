// POST /api/kiosk/register with a company code (MULTI_TENANCY Phase 1 B1).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PGDATABASE ||= 'kiosk-company-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'kiosk-company-tests';

const { createKioskRegistry } = require('../src/services/kioskRegistration');
const { hashEnrollmentCode } = require('../src/utils/kioskEnrollmentCode');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BRANCH_A_CLOSED = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const STAFF_B = '10000000-0000-4000-8000-00000000000b';
const DEVICE = 'Lenovo Tab [01]';
// Per-company enrollment codes (security review H1): BRADOBREY has its own.
const CODE_A = 'bradobrey-kiosk-code';
const DEFAULT_HASHES = { [COMPANY_A]: hashEnrollmentCode(CODE_A) };

const COMPANIES = [
  { id: COMPANY_A, code: 'BRADOBREY', status: 'active', is_default: true },
  { id: COMPANY_B, code: 'PRESIDENT', status: 'active', is_default: false },
  { id: 'cccccccc-0000-4000-8000-00000000000c', code: 'SLEEPY', status: 'suspended', is_default: false },
];
const BRANCHES = {
  [BRANCH_A1]: { id: BRANCH_A1, company_id: COMPANY_A, is_active: true },
  [BRANCH_A_CLOSED]: { id: BRANCH_A_CLOSED, company_id: COMPANY_A, is_active: false },
  [BRANCH_B1]: { id: BRANCH_B1, company_id: COMPANY_B, is_active: true },
};

function companiesRepo(list = COMPANIES, hashes = DEFAULT_HASHES) {
  return {
    async findActiveByCode(code) {
      return list.find((row) => row.code.toLowerCase() === String(code).toLowerCase() && row.status === 'active') || null;
    },
    async findDefault() { return list.find((row) => row.is_default) || null; },
    async countCompanies() { return list.length; },
    async findBranch(id) { return BRANCHES[id] || null; },
    async findKioskEnrollmentHash(id) { return hashes[id] || null; },
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

const registry = ({ list, hashes, warnings = [], enrollment = '', actors = {} } = {}) => createKioskRegistry({
  repo: kioskRepo(),
  companies: companiesRepo(list, hashes),
  enrollmentCode: () => enrollment,
  loadActor: async (claims) => actors[claims?.sub] || null,
  warn: (msg) => warnings.push(msg),
});

test('register with a company code accepts a branch of that company (case-insensitive, trimmed)', async () => {
  const result = await registry().register({ companyCode: '  bradobrey ', branchId: BRANCH_A1, deviceName: DEVICE, enrollmentCode: CODE_A });
  assert.equal(result.status, 201);
  assert.equal(result.body.branch_id, BRANCH_A1);
});

test('register: unknown and suspended companies give the same 404', async () => {
  const unknown = await registry().register({ companyCode: 'NOPE', branchId: BRANCH_A1, deviceName: DEVICE });
  const suspended = await registry().register({ companyCode: 'SLEEPY', branchId: BRANCH_A1, deviceName: DEVICE });
  const malformed = await registry().register({ companyCode: 'no spaces allowed', branchId: BRANCH_A1, deviceName: DEVICE });
  for (const result of [unknown, suspended, malformed]) {
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { code: 'COMPANY_NOT_FOUND', error: 'Company not found' });
  }
});

test('register: a branch of another company, unknown or closed is 403 KIOSK_BRANCH_FORBIDDEN', async () => {
  for (const branchId of [BRANCH_B1, BRANCH_A_CLOSED, '99999999-9999-4999-8999-999999999999']) {
    const result = await registry().register({ companyCode: 'BRADOBREY', branchId, deviceName: DEVICE, enrollmentCode: CODE_A });
    assert.equal(result.status, 403, branchId);
    assert.equal(result.body.code, 'KIOSK_BRANCH_FORBIDDEN');
  }
});

test('register without company_code works only while there is exactly one (default) company', async () => {
  const warnings = [];
  const single = registry({ list: [COMPANIES[0]], hashes: {}, warnings });
  const legacy = await single.register({ branchId: BRANCH_A1, deviceName: DEVICE });
  assert.equal(legacy.status, 201);
  assert.ok(warnings.some((msg) => msg.includes('without company_code')));

  const many = await registry().register({ branchId: BRANCH_A1, deviceName: DEVICE });
  assert.equal(many.status, 400);
  assert.equal(many.body.code, 'COMPANY_CODE_REQUIRED');
});

test('register: the company enrollment code applies after the company is resolved', async () => {
  const reg = registry({ enrollment: 's3cret' });
  assert.equal((await reg.register({ companyCode: 'BRADOBREY', branchId: BRANCH_A1, deviceName: DEVICE })).status, 403);
  assert.equal((await reg.register({ companyCode: 'BRADOBREY', branchId: BRANCH_A1, deviceName: DEVICE, enrollmentCode: 's3cret' })).status, 403, 'env code ignored with 2+ companies');
  assert.equal((await reg.register({ companyCode: 'BRADOBREY', branchId: BRANCH_A1, deviceName: DEVICE, enrollmentCode: CODE_A })).status, 201);
});

test('register: a staff actor of another company cannot enroll a kiosk here', async () => {
  const actors = { [STAFF_B]: { id: STAFF_B, role: 'admin', branchScope: [BRANCH_B1], companyId: COMPANY_B } };
  const reg = registry({ enrollment: 's3cret', actors });
  const foreign = await reg.register({ companyCode: 'BRADOBREY', branchId: BRANCH_A1, deviceName: DEVICE, actorClaims: { sub: STAFF_B } });
  assert.equal(foreign.status, 403);
  const own = await reg.register({ companyCode: 'PRESIDENT', branchId: BRANCH_B1, deviceName: DEVICE, actorClaims: { sub: STAFF_B } });
  assert.equal(own.status, 201);
});
