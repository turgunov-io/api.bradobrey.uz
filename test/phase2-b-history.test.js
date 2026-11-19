// Phase 2 (group B) H3: GET /api/history/branch must stay inside the caller's
// company, and a self-scoped caller (barber) only ever sees their own orders —
// never another branch picked through ?id=.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'phase2-b-history-secret';

const history = require('../src/models/history');
const { installDbMock, makeRes, eqCalls } = require('./helpers/tenantMocks');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const BARBER_B = '30000000-0000-4000-8000-00000000000b';

async function runBranch(req) {
  const mock = installDbMock({ queue_entries: [{ data: [], error: null }] });
  try {
    const res = makeRes();
    await history.branch(req, res);
    return { res, calls: mock.calls };
  } finally {
    mock.restore();
  }
}

test('history.branch: self scope ignores ?id of another company branch and filters by own barber + company', async () => {
  const { res, calls } = await runBranch({
    query: { id: BRANCH_A1 },
    historyAccess: {
      scope: { type: 'self', branchId: BRANCH_B1, employeeId: BARBER_B },
      user: { id: BARBER_B, company_id: COMPANY_B, branch_id: BRANCH_B1 },
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(eqCalls(calls, 'queue_entries', 'company_id'), [COMPANY_B]);
  assert.deepEqual(eqCalls(calls, 'queue_entries', 'barber_id'), [BARBER_B]);
  assert.ok(!eqCalls(calls, 'queue_entries', 'branch_id').includes(BRANCH_A1));
});

test('history.branch: self scope without a branch never falls back to ?id', async () => {
  const { res, calls } = await runBranch({
    query: { id: BRANCH_A1 },
    historyAccess: {
      scope: { type: 'self', branchId: null, employeeId: BARBER_B },
      user: { id: BARBER_B, company_id: COMPANY_B, branch_id: null },
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(eqCalls(calls, 'queue_entries', 'branch_id'), []);
  assert.deepEqual(eqCalls(calls, 'queue_entries', 'barber_id'), [BARBER_B]);
  assert.deepEqual(eqCalls(calls, 'queue_entries', 'company_id'), [COMPANY_B]);
});

test('history.branch: branch scope is bound to the caller company', async () => {
  const { res, calls } = await runBranch({
    query: {},
    historyAccess: {
      scope: { type: 'branch', branchId: BRANCH_B1, employeeId: null },
      user: { id: 'u', company_id: COMPANY_B, branch_id: BRANCH_B1 },
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(eqCalls(calls, 'queue_entries', 'branch_id'), [BRANCH_B1]);
  assert.deepEqual(eqCalls(calls, 'queue_entries', 'company_id'), [COMPANY_B]);
});

test('history.branch: fails closed without a company', async () => {
  const { res, calls } = await runBranch({
    query: {},
    historyAccess: { scope: { type: 'branch', branchId: BRANCH_B1 }, user: { id: 'u', company_id: null } },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
});

test('history.branch: without historyAccess (no auth) never queries', async () => {
  const { res, calls } = await runBranch({ query: { id: BRANCH_A1 } });
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
});
