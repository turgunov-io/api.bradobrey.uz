const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PGDATABASE ||= 'kiosk-scope-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'kiosk-scope-tests';
process.env.JWT_SECRET ||= 'kiosk-scope-test-secret';

const { db } = require('../src/config/postgres');
const kiosk = require('../src/models/kiosk');

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';
const COMPANY = 'cccccccc-0000-4000-8000-00000000000c';
const KIOSK = { id: '33333333-3333-4333-8333-333333333333', branchId: BRANCH_A, companyId: COMPANY };
// B2a: company lookups (branch -> company, legacy single-company mode).
const COMPANY_MOCKS = {
  branches: [{ data: { id: BRANCH_B, company_id: COMPANY }, error: null }],
  companies: [{ data: [{ id: COMPANY, is_default: true, status: 'active' }], error: null }],
};

function installDbMock(responsesByTable) {
  const calls = [];
  const originalFrom = db.from;
  db.from = (table) => {
    const response = (responsesByTable[table] || []).shift() || { data: [], error: null };
    const record = (method) => (...args) => { calls.push({ table, method, args }); return query; };
    const query = {
      then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); },
    };
    for (const method of ['select', 'eq', 'neq', 'in', 'is', 'or', 'order', 'limit', 'maybeSingle', 'single', 'update', 'insert', 'gt', 'gte', 'lt', 'lte']) {
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

const orFilters = (calls) => calls.filter((call) => call.table === 'services' && call.method === 'or').map((call) => call.args[0]);

test('GET /api/kiosk/services is filtered to the authenticated kiosk branch plus shared services', async () => {
  const mock = installDbMock({ ...COMPANY_MOCKS, services: [{ data: [], error: null }] });
  try {
    const res = makeRes();
    await kiosk.services({ query: { branch_id: BRANCH_B }, kiosk: KIOSK, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(orFilters(mock.calls), [`branch_id.eq.${BRANCH_A},branch_id.is.null`]);
  } finally {
    mock.restore();
  }
});

test('GET /api/kiosk/services falls back to ?branch_id and rejects a malformed one', async () => {
  const mock = installDbMock({ ...COMPANY_MOCKS, services: [{ data: [], error: null }] });
  try {
    const res = makeRes();
    await kiosk.services({ query: { branch_id: BRANCH_B }, headers: {} }, res);
    assert.deepEqual(orFilters(mock.calls), [`branch_id.eq.${BRANCH_B},branch_id.is.null`]);

    const bad = makeRes();
    await kiosk.services({ query: { branch_id: 'x,branch_id.neq.null' }, headers: {} }, bad);
    assert.equal(bad.statusCode, 400);
  } finally {
    mock.restore();
  }
});

test('GET /api/kiosk/services without any branch keeps the legacy unfiltered list', async () => {
  const mock = installDbMock({ ...COMPANY_MOCKS, services: [{ data: [{ id: 's1', name: 'Cut', is_active: true }], error: null }] });
  try {
    const res = makeRes();
    await kiosk.services({ query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(orFilters(mock.calls), []);
    assert.equal(res.payload.services.length, 1);
  } finally {
    mock.restore();
  }
});

function bookingMocks(services) {
  return {
    branches: [{ data: { id: BRANCH_A, company_id: COMPANY, timezone: 'Asia/Tashkent', marketplace_barbershop_id: null }, error: null }],
    barbers: [{ data: { id: 'barber-1', branch_id: BRANCH_A, is_on_shift: true, is_archived: false }, error: null }],
    users: [{ data: { id: 'barber-1', role: 'barber' }, error: null }],
    services: [{ data: services, error: null }],
  };
}

const bookingBody = (serviceIds) => ({
  branch_id: BRANCH_A,
  barber_id: 'barber-1',
  service_ids: serviceIds,
  customer_name: 'Ali',
  phone_number: '+998991234567',
});

test('POST /book rejects a service that belongs to another branch', async () => {
  const mock = installDbMock(bookingMocks([
    { id: 's1', is_active: true, base_price: 100, branch_id: BRANCH_A },
    { id: 's2', is_active: true, base_price: 100, branch_id: BRANCH_B },
  ]));
  try {
    const res = makeRes();
    await kiosk.book({ body: bookingBody(['s1', 's2']), headers: {}, app: { get: () => null } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /s2/);
  } finally {
    mock.restore();
  }
});

test('POST /book still rejects inactive services', async () => {
  const mock = installDbMock(bookingMocks([{ id: 's1', is_active: false, base_price: 100, branch_id: null }]));
  try {
    const res = makeRes();
    await kiosk.book({ body: bookingBody(['s1']), headers: {}, app: { get: () => null } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /not active/);
  } finally {
    mock.restore();
  }
});

test('POST /book selects branch_id so shared and same-branch services pass the scope check', async () => {
  const mock = installDbMock(bookingMocks([
    { id: 's1', is_active: true, base_price: 100, branch_id: null },
    { id: 's2', is_active: true, base_price: 100, branch_id: BRANCH_A },
  ]));
  try {
    const res = makeRes();
    await kiosk.book({ body: bookingBody(['s1', 's2']), headers: {}, app: { get: () => null } }, res);
    const select = mock.calls.find((call) => call.table === 'services' && call.method === 'select');
    assert.match(select.args[0], /branch_id/);
    assert.notEqual(res.payload?.error, 'One or more services are not available in this branch');
  } finally {
    mock.restore();
  }
});

test('monitor queue status hides entries of another branch from an authenticated kiosk', async () => {
  const mock = installDbMock({
    queue_entries: [{ data: { id: 'q1', status: 'completed', branch_id: BRANCH_B }, error: null }],
  });
  try {
    const res = makeRes();
    await kiosk.queueStatus({ params: { id: 'q1' }, kiosk: KIOSK, headers: {} }, res);
    assert.equal(res.statusCode, 404);
  } finally {
    mock.restore();
  }
});

test('monitor queue status still answers for the kiosk own branch', async () => {
  const mock = installDbMock({
    queue_entries: [{ data: { id: 'q1', status: 'completed', branch_id: BRANCH_A }, error: null }],
  });
  try {
    const res = makeRes();
    await kiosk.queueStatus({ params: { id: 'q1' }, kiosk: KIOSK, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.entry.id, 'q1');
  } finally {
    mock.restore();
  }
});

test('monitor cancel is scoped to the authenticated kiosk branch', async () => {
  const mock = installDbMock({
    queue_entries: [{ data: null, error: null }, { data: null, error: null }],
  });
  try {
    const res = makeRes();
    await kiosk.cancelQueue({ params: { id: 'q1' }, kiosk: KIOSK, headers: {}, app: { get: () => null } }, res);
    assert.equal(res.statusCode, 404);
    const branchFilters = mock.calls.filter((call) => call.method === 'eq' && call.args[0] === 'branch_id');
    assert.equal(branchFilters.length, 2);
    assert.ok(branchFilters.every((call) => call.args[1] === BRANCH_A));
  } finally {
    mock.restore();
  }
});

test('certificate lookup accepts an authenticated kiosk instead of a bearer token', async () => {
  const mock = installDbMock({ certificates: [{ data: null, error: null }] });
  try {
    const anonymous = makeRes();
    await kiosk.certificate({ params: { id: 'abc' }, headers: {} }, anonymous);
    assert.equal(anonymous.statusCode, 401);

    const res = makeRes();
    await kiosk.certificate({ params: { id: 'abc' }, headers: {}, kiosk: KIOSK }, res);
    assert.equal(res.statusCode, 404);
  } finally {
    mock.restore();
  }
});

test('GET /api/kiosk/services without branch_id is scoped to a bearer employee\'s allowed branches', async () => {
  const BRANCH_C = '99999999-9999-4999-8999-999999999999';
  const rows = [
    { id: 'sa', name: 'A', is_active: true, branch_id: BRANCH_A },
    { id: 'sb', name: 'B', is_active: true, branch_id: BRANCH_B },
    { id: 'sc', name: 'C', is_active: true, branch_id: BRANCH_C },
    { id: 'shared', name: 'S', is_active: true, branch_id: null },
  ];

  const single = installDbMock({ ...COMPANY_MOCKS, services: [{ data: rows.filter((r) => r.branch_id === BRANCH_A || !r.branch_id), error: null }] });
  try {
    const res = makeRes();
    await kiosk.services({ query: {}, headers: {}, kioskStaff: { companyId: COMPANY, id: 'u', role: 'admin_branch', branchScope: [BRANCH_A] } }, res);
    assert.deepEqual(orFilters(single.calls), [`branch_id.eq.${BRANCH_A},branch_id.is.null`]);
  } finally {
    single.restore();
  }

  const multi = installDbMock({ ...COMPANY_MOCKS, services: [{ data: rows, error: null }] });
  try {
    const res = makeRes();
    await kiosk.services({ query: {}, headers: {}, kioskStaff: { companyId: COMPANY, id: 'u', role: 'merchant', branchScope: [BRANCH_A, BRANCH_C] } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.services.map((s) => s.id).sort(), ['sa', 'sc', 'shared']);
  } finally {
    multi.restore();
  }

  const network = installDbMock({ ...COMPANY_MOCKS, services: [{ data: rows, error: null }] });
  try {
    const res = makeRes();
    await kiosk.services({ query: {}, headers: {}, kioskStaff: { companyId: COMPANY, id: 'u', role: 'admin', branchScope: null } }, res);
    assert.equal(res.payload.services.length, 4);
  } finally {
    network.restore();
  }
});
