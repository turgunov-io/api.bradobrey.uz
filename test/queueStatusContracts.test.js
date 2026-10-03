const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.PGDATABASE ||= 'queue-contract-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'queue-contract-tests';
process.env.JWT_SECRET ||= 'queue-contract-test-secret';

const { db, pool } = require('../src/config/postgres');
const barbers = require('../src/models/barbers');
const kiosk = require('../src/models/kiosk');

const ACTIVE_QUEUE_STATUSES = ['waiting', 'called', 'swapped', 'in_progress'];

function createQuery(table, response, calls) {
  const query = {
    delete() { return this; },
    eq(column, value) { calls.push({ method: 'eq', table, column, value }); return this; },
    gt() { return this; },
    gte() { return this; },
    in(column, value) { calls.push({ method: 'in', table, column, value }); return this; },
    insert() { return this; },
    limit() { return this; },
    lt() { return this; },
    lte() { return this; },
    maybeSingle() { return this; },
    neq() { return this; },
    order() { return this; },
    select() { return this; },
    single() { return this; },
    update() { return this; },
    then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); },
  };

  return query;
}

function installDbMock(responsesByTable) {
  const calls = [];
  const originalFrom = db.from;

  db.from = (table) => {
    const responses = responsesByTable[table] || [];
    const response = responses.shift() || { data: [], error: null };
    calls.push({ method: 'from', table });
    return createQuery(table, response, calls);
  };

  return {
    calls,
    restore() {
      db.from = originalFrom;
    },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test('GET /api/barbers/queue uses the canonical active statuses in primary and fallback queries', async () => {
  const createdAt = new Date().toISOString();
  const mock = installDbMock({
    queue_entries: [
      { data: [], error: null },
      { data: [], error: { message: "Could not find the 'certificate_id' column" } },
      { data: [{ id: 'queue-swapped', status: 'swapped', created_at: createdAt }], error: null },
    ],
    promo_code_usage: [{ data: [], error: null }],
    cashback_transactions: [{ data: [], error: null }],
  });

  try {
    const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);
    const req = { headers: { authorization: `Bearer ${token}` }, query: {} };
    const res = createResponse();

    await barbers.myQueue(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.items.map((item) => item.status), ['swapped']);
    const statusFilters = mock.calls.filter((call) => (
      call.method === 'in' && call.table === 'queue_entries' && call.column === 'status'
    ));
    assert.equal(statusFilters.length, 3);
    assert.deepEqual(statusFilters[1].value, ACTIVE_QUEUE_STATUSES);
    assert.deepEqual(statusFilters[2].value, ACTIVE_QUEUE_STATUSES);
  } finally {
    mock.restore();
  }
});

test('GET /api/kiosk/barbers/:branch_id counts only canonical active queue statuses', async () => {
  const createdAt = new Date().toISOString();
  const mock = installDbMock({
    queue_entries: [
      { data: [], error: null },
      {
        data: [
          { id: 'waiting', barber_id: 'barber-1', client_id: 'client-1', status: 'waiting', created_at: createdAt, service_ids: ['service-1'] },
          { id: 'called', barber_id: 'barber-1', client_id: 'client-2', status: 'called', created_at: createdAt, service_ids: ['service-1'] },
          { id: 'swapped', barber_id: 'barber-1', client_id: 'client-3', status: 'swapped', created_at: createdAt, service_ids: ['service-1'] },
          { id: 'in-progress', barber_id: 'barber-1', client_id: 'client-4', status: 'in_progress', created_at: createdAt, service_ids: ['service-1'] },
          { id: 'cancelled', barber_id: 'barber-1', client_id: 'client-5', status: 'cancelled', created_at: createdAt, service_ids: ['service-1'] },
          { id: 'rejected', barber_id: 'barber-1', client_id: 'client-6', status: 'rejected', created_at: createdAt, service_ids: ['service-1'] },
          { id: 'transfer', barber_id: 'barber-1', client_id: 'client-7', status: 'transfer_pending', created_at: createdAt, service_ids: ['service-1'] },
        ],
        error: null,
      },
    ],
    barbers: [{ data: [{ id: 'barber-1', name: 'Barber', branch_id: 'branch-1' }], error: null }],
    users: [{ data: [{ id: 'barber-1', role: 'barber' }], error: null }],
    services: [{ data: [{ id: 'service-1', duration_minutes: 10 }], error: null }],
    clients: [{ data: [], error: null }],
  });

  try {
    const res = createResponse();
    await kiosk.barbers({ params: { branch_id: 'branch-1' } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.payload.barbers[0].clients.map((entry) => entry.status),
      ACTIVE_QUEUE_STATUSES,
    );
    assert.equal(res.payload.barbers[0].estimated_waiting_time, 40);
    assert.equal(res.payload.overall_estimated_waiting_time, 40);
    const statusFilter = mock.calls.filter((call) => (
      call.method === 'in' && call.table === 'queue_entries' && call.column === 'status'
    )).at(-1);
    assert.deepEqual(statusFilter.value, ACTIVE_QUEUE_STATUSES);
  } finally {
    mock.restore();
  }
});

test.after(async () => {
  await pool.end();
});
