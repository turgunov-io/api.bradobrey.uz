// MULTI_TENANCY Phase 2 (group A, M2): GET /api/kiosk/barbers/:branch_id and
// /api/monitor/barbers/:branch_id compare the caller's company (kiosk device
// token / staff) with the branch's company, like book() does. Without any
// token (legacy kiosks) the roster stays public only while one company is
// active; with 2+ companies it needs a token (as queueStatus, review H2).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'phase2-a-kiosk-barbers-secret';

const { installFakeDb } = require('./helpers/phase2aFakeDb');
const kiosk = require('../src/models/kiosk');
const { makeRes } = require('./helpers/tenantMocks');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';

const seed = (companies) => ({
  companies,
  branches: [
    { id: BRANCH_A1, company_id: COMPANY_A, timezone: 'Asia/Tashkent' },
    { id: BRANCH_B1, company_id: COMPANY_B, timezone: 'Asia/Tashkent' },
  ],
  barbers: [],
  queue_entries: [],
  employee_active_branches: [],
  employee_branch_access: [],
});
const twoCompanies = () => seed([
  { id: COMPANY_A, is_default: true, status: 'active' },
  { id: COMPANY_B, is_default: false, status: 'active' },
]);
const oneCompany = () => seed([{ id: COMPANY_A, is_default: true, status: 'active' }]);

async function barbers(req, data) {
  const fake = installFakeDb(data);
  const res = makeRes();
  try {
    await kiosk.barbers({ headers: {}, query: {}, body: {}, ...req }, res);
  } finally {
    fake.restore();
  }
  return { res, fake };
}

test('kiosk barbers: a company B kiosk cannot read (or clean up) a company A branch roster', async () => {
  const { res, fake } = await barbers({ params: { branch_id: BRANCH_A1 }, kiosk: { companyId: COMPANY_B, branchId: BRANCH_B1 } }, twoCompanies());
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'BRANCH_COMPANY_MISMATCH');
  assert.ok(!fake.writes.length, 'no stale-queue cleanup on a foreign branch');
});

test('kiosk barbers: company B staff cannot read a company A branch roster', async () => {
  const { res } = await barbers({ params: { branch_id: BRANCH_A1 }, tenant: { companyId: COMPANY_B, isPlatformOwner: false } }, twoCompanies());
  assert.equal(res.statusCode, 403);
});

test('kiosk barbers: own branch is served', async () => {
  const { res } = await barbers({ params: { branch_id: BRANCH_B1 }, kiosk: { companyId: COMPANY_B, branchId: BRANCH_B1 } }, twoCompanies());
  assert.equal(res.statusCode, 200);
});

test('kiosk barbers: legacy no-token mode unchanged with a single active company', async () => {
  const { res } = await barbers({ params: { branch_id: BRANCH_A1 } }, oneCompany());
  assert.equal(res.statusCode, 200);
});

test('kiosk barbers: no token with two active companies -> 401 KIOSK_TOKEN_REQUIRED', async () => {
  const { res } = await barbers({ params: { branch_id: BRANCH_A1 } }, twoCompanies());
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'KIOSK_TOKEN_REQUIRED');
});
