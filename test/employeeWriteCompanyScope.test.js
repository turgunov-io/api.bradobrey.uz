// Security review L5 (defence in depth): employee edits, archive and restore
// by id only ever touch users/barbers rows of the actor's company, even if a
// route guard were bypassed.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PGDATABASE ||= 'employee-write-scope-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'employee-write-scope-tests';
process.env.JWT_SECRET ||= 'employee-write-scope-secret';

const { db } = require('../src/config/postgres');
const barbers = require('../src/models/barbers');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const FOREIGN_EMPLOYEE = '20000000-0000-4000-8000-00000000000b';

function installDbMock(responsesByTable = {}) {
  const calls = [];
  const originalFrom = db.from;
  db.from = (table) => {
    const response = (responsesByTable[table] || []).shift() || { data: null, error: null };
    const record = (method) => (...args) => { calls.push({ table, method, args }); return query; };
    const query = { then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); } };
    for (const method of ['select', 'eq', 'in', 'is', 'order', 'limit', 'maybeSingle', 'single', 'update', 'upsert', 'insert', 'delete']) {
      query[method] = record(method);
    }
    return query;
  };
  return { calls, restore() { db.from = originalFrom; } };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

const companyEq = (calls, table) => calls.filter((c) => c.table === table && c.method === 'eq' && c.args[0] === 'company_id').map((c) => c.args[1]);
const writes = (calls, table) => calls.filter((c) => c.table === table && ['update', 'upsert', 'insert', 'delete'].includes(c.method));

const updateBody = { login: 'ali', name: 'Ali', branch_id: BRANCH_A, role: 'barber' };
const managed = (extra = {}) => ({
  params: { id: FOREIGN_EMPLOYEE },
  body: { ...updateBody },
  headers: {},
  employeeManagement: { companyId: COMPANY_A },
  tenant: { companyId: COMPANY_A },
  app: { get: () => null },
  ...extra,
});

test('updateEmployee filters the users update by the actor company; another company employee is 404', async () => {
  const mock = installDbMock({ users: [{ data: null, error: null }] });
  try {
    const res = makeRes();
    await barbers.updateEmployee(managed(), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(companyEq(mock.calls, 'users'), [COMPANY_A]);
    assert.equal(writes(mock.calls, 'barbers').length, 0, 'barber row untouched');
  } finally {
    mock.restore();
  }
});

test('updateEmployee without an actor company is 403 and writes nothing', async () => {
  const mock = installDbMock();
  try {
    const res = makeRes();
    await barbers.updateEmployee(managed({ employeeManagement: {}, tenant: {} }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

for (const handler of ['archiveEmployee', 'restoreEmployee']) {
  test(`${handler} loads the employee within the actor company only`, async () => {
    const mock = installDbMock({ users: [{ data: null, error: null }], barbers: [{ data: null, error: null }] });
    try {
      const res = makeRes();
      await barbers[handler](managed({ body: {} }), res);
      assert.equal(res.statusCode, 404);
      assert.deepEqual(companyEq(mock.calls, 'users'), [COMPANY_A]);
      assert.deepEqual(companyEq(mock.calls, 'barbers'), [COMPANY_A]);
      assert.equal(writes(mock.calls, 'barbers').length, 0);
    } finally {
      mock.restore();
    }
  });

  test(`${handler} without an actor company is 403`, async () => {
    const mock = installDbMock();
    try {
      const res = makeRes();
      await barbers[handler](managed({ body: {}, employeeManagement: {}, tenant: {} }), res);
      assert.equal(res.statusCode, 403);
      assert.equal(mock.calls.length, 0);
    } finally {
      mock.restore();
    }
  });
}
