// Phase 2 (group B) H2: POST /api/barbers/shift/{start,end} (verifix
// setShiftState) loads and updates the barber only inside the caller's company
// and checks that the barber may work in the requested in-scope branch.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'phase2-b-verifix-secret';

const verifix = require('../src/models/verifix');
const employeeBranches = require('../src/utils/employeeBranches');
const { installDbMock, makeRes, eqCalls } = require('./helpers/tenantMocks');

const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const ADMIN_B = '20000000-0000-4000-8000-00000000000b';
const BARBER_A = '30000000-0000-4000-8000-00000000000a';
const BARBER_B = '30000000-0000-4000-8000-00000000000b';

const adminReq = (body, actor = {}) => ({
  headers: { authorization: 'Bearer x' },
  body,
  query: {},
  app: { get: () => null },
  dbActor: { id: ADMIN_B, role: 'admin_branch', branchScope: [BRANCH_B1], sessionBranchId: BRANCH_B1, companyId: COMPANY_B, ...actor },
});

async function withStubs({ canUse = true, barbers }, fn) {
  const original = { ...employeeBranches };
  employeeBranches.employeeCanUseBranch = async () => canUse;
  employeeBranches.setActiveEmployeeBranch = async () => {};
  const mock = installDbMock({
    barbers,
    branches: [{ data: { id: BRANCH_B1, name: 'B1', timezone: 'Asia/Tashkent' }, error: null },
      { data: { id: BRANCH_B1, name: 'B1', timezone: 'Asia/Tashkent' }, error: null }],
    barber_activity_events: [{ data: { id: 'e1' }, error: null }],
  });
  try {
    return await fn(mock.calls);
  } finally {
    mock.restore();
    Object.assign(employeeBranches, original);
  }
}

// requireAuth verifies the bearer itself; sign a real token.
const jwt = require('jsonwebtoken');
const bearer = () => `Bearer ${jwt.sign({ sub: ADMIN_B, role: 'admin_branch' }, process.env.JWT_SECRET, { algorithm: 'HS256' })}`;

test('verifix shift: admin of company B cannot toggle a company A barber', async () => {
  await withStubs({ barbers: [{ data: null, error: null }] }, async (calls) => {
    const req = adminReq({ barber_id: BARBER_A, branch_id: BRANCH_B1 });
    req.headers.authorization = bearer();
    const res = makeRes();
    await verifix.startShift(req, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(eqCalls(calls, 'barbers', 'company_id'), [COMPANY_B]);
    assert.ok(!calls.some((c) => c.table === 'barbers' && c.method === 'update'));
  });
});

test('verifix shift: admin cannot put a barber on shift in a branch the barber may not use', async () => {
  await withStubs({ canUse: false, barbers: [{ data: { id: BARBER_B, name: 'b', branch_id: 'other' }, error: null }] }, async (calls) => {
    const req = adminReq({ barber_id: BARBER_B, branch_id: BRANCH_B1 });
    req.headers.authorization = bearer();
    const res = makeRes();
    await verifix.startShift(req, res);
    assert.equal(res.statusCode, 403);
    assert.ok(!calls.some((c) => c.table === 'barbers' && c.method === 'update'));
  });
});

test('verifix shift: the barbers update is filtered by the caller company', async () => {
  const barberRow = { data: { id: BARBER_B, name: 'b', branch_id: BRANCH_B1 }, error: null };
  await withStubs({ barbers: [barberRow, { data: { ...barberRow.data, is_on_shift: true }, error: null }, barberRow] }, async (calls) => {
    const req = adminReq({ barber_id: BARBER_B, branch_id: BRANCH_B1 });
    req.headers.authorization = bearer();
    const res = makeRes();
    await verifix.startShift(req, res);
    const updateIndex = calls.findIndex((c) => c.table === 'barbers' && c.method === 'update');
    assert.ok(updateIndex >= 0, 'update issued');
    const afterUpdate = calls.slice(updateIndex).filter((c) => c.table === 'barbers' && c.method === 'eq');
    assert.ok(afterUpdate.some((c) => c.args[0] === 'company_id' && c.args[1] === COMPANY_B));
    assert.ok(afterUpdate.some((c) => c.args[0] === 'id' && c.args[1] === BARBER_B));
  });
});

test('verifix shift: no company on the actor fails closed', async () => {
  await withStubs({ barbers: [] }, async (calls) => {
    const req = adminReq({ barber_id: BARBER_B, branch_id: BRANCH_B1 }, { companyId: null });
    req.headers.authorization = bearer();
    const res = makeRes();
    await verifix.startShift(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(calls.filter((c) => c.table === 'barbers').length, 0);
  });
});
