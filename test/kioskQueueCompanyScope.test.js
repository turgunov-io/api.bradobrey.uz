// /api/monitor/queue/:id/status and /cancel (models/kiosk.js queueStatus,
// cancelQueue) — security review H2: queue entries are read/cancelled only
// inside the caller's company. With a kiosk token the company is the kiosk's;
// without one (legacy mode, KIOSK_AUTH_ENFORCE off) only while exactly one
// company exists, otherwise 401.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PGDATABASE ||= 'kiosk-queue-scope-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'kiosk-queue-scope-tests';
process.env.JWT_SECRET ||= 'kiosk-queue-scope-secret';

const { db } = require('../src/config/postgres');
const kiosk = require('../src/models/kiosk');

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ENTRY_ID = '55555555-5555-4555-8555-555555555555';
const KIOSK = { id: '33333333-3333-4333-8333-333333333333', branchId: BRANCH_A, companyId: COMPANY_A };
const ENTRY = { id: ENTRY_ID, status: 'completed', branch_id: BRANCH_A, barber_id: 'b1', company_id: COMPANY_A };

const ONE_COMPANY = [{ id: COMPANY_A, is_default: true, status: 'active' }];
const TWO_COMPANIES = [...ONE_COMPANY, { id: COMPANY_B, is_default: false, status: 'active' }];

function installDbMock(responsesByTable) {
  const calls = [];
  const originalFrom = db.from;
  db.from = (table) => {
    const response = (responsesByTable[table] || []).shift() || { data: null, error: null };
    const record = (method) => (...args) => { calls.push({ table, method, args }); return query; };
    const query = { then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); } };
    for (const method of ['select', 'eq', 'neq', 'in', 'is', 'or', 'order', 'limit', 'maybeSingle', 'single', 'update', 'insert']) {
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

const companyFilters = (calls) => calls
  .filter((call) => call.table === 'queue_entries' && call.method === 'eq' && call.args[0] === 'company_id')
  .map((call) => call.args[1]);

const request = (extra = {}) => ({ params: { id: ENTRY_ID }, headers: {}, query: {}, body: {}, app: { get: () => null }, ...extra });

test('queueStatus with a kiosk token filters the entry by the kiosk company', async () => {
  const mock = installDbMock({ queue_entries: [{ data: ENTRY, error: null }] });
  try {
    const res = makeRes();
    await kiosk.queueStatus(request({ kiosk: KIOSK }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(companyFilters(mock.calls), [COMPANY_A]);
  } finally {
    mock.restore();
  }
});

test('queueStatus without a kiosk token: legacy single company is scoped, 2+ companies -> 401', async () => {
  const single = installDbMock({ companies: [{ data: ONE_COMPANY, error: null }], queue_entries: [{ data: ENTRY, error: null }] });
  try {
    const res = makeRes();
    await kiosk.queueStatus(request(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(companyFilters(single.calls), [COMPANY_A]);
  } finally {
    single.restore();
  }

  const many = installDbMock({ companies: [{ data: TWO_COMPANIES, error: null }], queue_entries: [{ data: ENTRY, error: null }] });
  try {
    const res = makeRes();
    await kiosk.queueStatus(request(), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'KIOSK_TOKEN_REQUIRED');
    assert.equal(many.calls.filter((call) => call.table === 'queue_entries').length, 0, 'no queue lookup');
  } finally {
    many.restore();
  }
});

test('cancelQueue scopes the update and the fallback lookup to the company', async () => {
  const mock = installDbMock({
    queue_entries: [{ data: null, error: null }, { data: null, error: null }],
  });
  try {
    const res = makeRes();
    await kiosk.cancelQueue(request({ kiosk: KIOSK }), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(companyFilters(mock.calls), [COMPANY_A, COMPANY_A]);
  } finally {
    mock.restore();
  }
});

test('cancelQueue without a kiosk token and 2+ companies is 401 and writes nothing', async () => {
  const mock = installDbMock({ companies: [{ data: TWO_COMPANIES, error: null }] });
  try {
    const res = makeRes();
    await kiosk.cancelQueue(request(), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'KIOSK_TOKEN_REQUIRED');
    assert.equal(mock.calls.filter((call) => call.table === 'queue_entries').length, 0);
  } finally {
    mock.restore();
  }
});
