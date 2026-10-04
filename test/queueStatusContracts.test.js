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
const queueTransfers = require('../src/models/queueTransfers');

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
    select(value) { calls.push({ method: 'select', table, value }); return this; },
    single() { return this; },
    update(value) { calls.push({ method: 'update', table, value }); return this; },
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
  const transfer = {
    id: 'transfer-1',
    queue_entry_id: 'queue-swapped',
    from_barber_id: 'barber-a',
    to_barber_id: 'barber-1',
    status: 'accepted',
    original_status: 'called',
    requested_at: '2026-10-03T10:00:00Z',
    responded_at: '2026-10-03T10:01:00Z',
  };
  const mock = installDbMock({
    queue_entries: [
      { data: [], error: null },
      { data: [], error: { message: "Could not find the 'certificate_id' column" } },
      { data: [{ id: 'queue-swapped', status: 'swapped', created_at: createdAt }], error: null },
    ],
    promo_code_usage: [{ data: [], error: null }],
    cashback_transactions: [{ data: [], error: null }],
    queue_transfer_events: [{ data: [transfer], error: null }],
    barbers: [{ data: [
      { id: 'barber-a', name: 'Barber A' },
      { id: 'barber-1', name: 'Barber B' },
    ], error: null }],
  });

  try {
    const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);
    const req = { headers: { authorization: `Bearer ${token}` }, query: {} };
    const res = createResponse();

    await barbers.myQueue(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.items.map((item) => item.status), ['swapped']);
    assert.deepEqual(res.payload.items[0].transfer_history, [{
      ...transfer,
      from_barber_name: 'Barber A',
      to_barber_name: 'Barber B',
    }]);
    assert.equal('client_id' in res.payload.items[0].transfer_history[0], false);
    assert.equal('reason' in res.payload.items[0].transfer_history[0], false);
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
  const overdueStartedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const mock = installDbMock({
    queue_entries: [
      { data: [], error: null },
      {
        data: [
          { id: 'waiting', barber_id: 'barber-1', client_id: 'client-1', status: 'waiting', created_at: createdAt, service_ids: ['service-1'] },
          { id: 'called', barber_id: 'barber-1', client_id: 'client-2', status: 'called', created_at: createdAt, service_ids: ['service-1'] },
          { id: 'swapped', barber_id: 'barber-1', client_id: 'client-3', status: 'swapped', created_at: createdAt, service_ids: ['service-1'] },
          { id: 'in-progress', barber_id: 'barber-1', client_id: 'client-4', status: 'in_progress', created_at: createdAt, started_at: overdueStartedAt, service_ids: ['service-1'] },
          { id: 'cancelled', barber_id: 'barber-1', client_id: 'client-5', status: 'cancelled', created_at: createdAt, service_ids: ['service-1'] },
          { id: 'rejected', barber_id: 'barber-1', client_id: 'client-6', status: 'rejected', created_at: createdAt, service_ids: ['service-1'] },
          { id: 'transfer', barber_id: 'barber-1', client_id: 'client-7', status: 'transfer_pending', created_at: createdAt, service_ids: ['service-1'] },
        ],
        error: null,
      },
    ],
    barbers: [{ data: [{ id: 'barber-1', name: 'Barber', branch_id: 'branch-1', is_active: true, is_on_shift: true }], error: null }],
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
    assert.equal(res.payload.barbers[0].estimated_waiting_time, 31);
    assert.equal(res.payload.overall_estimated_waiting_time, 31);
    assert.equal(res.payload.barbers[0].availability_status, 'busy');
    assert.equal(res.payload.barbers[0].is_available, false);
    assert.equal(res.payload.barbers[0].has_in_progress, true);
    assert.equal(res.payload.barbers[0].current_service_overdue, true);
    assert.equal(res.payload.barbers[0].active_queue_count, 4);
    const statusFilter = mock.calls.filter((call) => (
      call.method === 'in' && call.table === 'queue_entries' && call.column === 'status'
    )).at(-1);
    assert.deepEqual(statusFilter.value, ACTIVE_QUEUE_STATUSES);
  } finally {
    mock.restore();
  }
});

test('PATCH /api/barbers/queue/:id/edit-before-complete enriches services and emits ETA refresh', async () => {
  const services = [
    { id: 'service-1', name: 'Haircut', base_price: 100, duration_minutes: 20, is_active: true },
    { id: 'service-2', name: 'Beard', base_price: 50, duration_minutes: 10, is_active: true },
  ];
  const mock = installDbMock({
    queue_entries: [
      { data: { id: 'queue-1', barber_id: 'barber-1', branch_id: 'branch-1', status: 'in_progress', started_at: new Date().toISOString(), service_id: 'service-1', service_ids: ['service-1'] }, error: null },
      { data: { id: 'queue-1', barber_id: 'barber-1', branch_id: 'branch-1', status: 'in_progress', started_at: new Date().toISOString(), service_id: 'service-1', service_ids: ['service-1', 'service-2'], price_override: null }, error: null },
    ],
    services: [
      { data: services, error: null },
      { data: services, error: null },
    ],
  });
  const emitted = [];

  try {
    const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);
    const req = {
      app: { get: () => ({ to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }) }) },
      body: { add_service_ids: ['service-2'] },
      headers: { authorization: `Bearer ${token}` },
      params: { id: 'queue-1' },
    };
    const res = createResponse();

    await barbers.editBeforeComplete(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.entry.service_ids, ['service-1', 'service-2']);
    assert.equal(res.payload.entry.total_duration, 30);
    assert.equal(res.payload.entry.total_price, 150);
    assert.equal(res.payload.entry.status, 'in_progress');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'queue:update');
    assert.equal(emitted[0].payload.type, 'queue_updated');
    assert.equal(emitted[0].payload.total_duration, 30);
  } finally {
    mock.restore();
  }
});

test('PATCH /api/barbers/queue/:id validates in-progress services and returns enriched totals', async () => {
  const services = [
    { id: 'service-1', name: 'Haircut', base_price: 100, duration_minutes: 20, is_active: true },
    { id: 'service-2', name: 'Beard', base_price: 50, duration_minutes: 10, is_active: true },
  ];
  const startedAt = new Date().toISOString();
  const mock = installDbMock({
    queue_entries: [
      { data: { id: 'queue-1', barber_id: 'barber-1', branch_id: 'branch-1', status: 'in_progress', started_at: startedAt, service_id: 'service-1', service_ids: ['service-1'] }, error: null },
      { data: { id: 'queue-1', barber_id: 'barber-1', branch_id: 'branch-1', status: 'in_progress', started_at: startedAt, service_id: 'service-1', service_ids: ['service-1', 'service-2'], price_override: null }, error: null },
    ],
    services: [
      { data: services, error: null },
      { data: services, error: null },
    ],
  });
  const emitted = [];

  try {
    const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);
    const req = {
      app: { get: () => ({ to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }) }) },
      body: { service_ids: ['service-1', 'service-2'] },
      headers: { authorization: `Bearer ${token}` },
      params: { id: 'queue-1' },
    };
    const res = createResponse();

    await barbers.updateQueue(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.entry.started_at, startedAt);
    assert.equal(res.payload.entry.services.length, 2);
    assert.equal(res.payload.entry.total_duration, 30);
    assert.equal(res.payload.entry.total_price, 150);
    assert.equal(emitted[0].payload.type, 'queue_updated');
    assert.equal(emitted[0].payload.entryId, 'queue-1');
  } finally {
    mock.restore();
  }
});

test('generic queue PATCH cannot reopen or change any terminal status', async () => {
  const terminalStatuses = ['completed', 'cancelled', 'rejected', 'no_show', 'not_in_time'];
  const mock = installDbMock({
    queue_entries: terminalStatuses.map((status) => ({
      data: {
        id: `queue-${status}`,
        barber_id: 'barber-1',
        branch_id: 'branch-1',
        status,
        service_id: 'service-1',
        service_ids: ['service-1'],
      },
      error: null,
    })),
  });
  const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);

  try {
    for (const status of terminalStatuses) {
      const req = {
        app: { get: () => null },
        body: { status: 'waiting' },
        headers: { authorization: `Bearer ${token}` },
        params: { id: `queue-${status}` },
      };
      const res = createResponse();
      await barbers.updateQueue(req, res);
      assert.equal(res.statusCode, 409);
      assert.match(res.payload.error, new RegExp(`terminal queue entry in status ${status}`));
    }
    assert.equal(mock.calls.some((call) => call.method === 'update'), false);
  } finally {
    mock.restore();
  }
});

test('generic queue PATCH cannot mutate services or payment on terminal entries', async () => {
  const mutations = [
    { payment_method: 'card' },
    { service_id: 'service-2' },
    { service_ids: ['service-1', 'service-2'] },
    { status: 'completed', payment_method: 'cash' },
  ];
  const mock = installDbMock({
    queue_entries: mutations.map((_, index) => ({
      data: {
        id: `terminal-${index}`,
        barber_id: 'barber-1',
        branch_id: 'branch-1',
        status: 'completed',
        service_id: 'service-1',
        service_ids: ['service-1'],
      },
      error: null,
    })),
  });
  const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);

  try {
    for (let index = 0; index < mutations.length; index += 1) {
      const res = createResponse();
      await barbers.updateQueue({
        app: { get: () => null },
        body: mutations[index],
        headers: { authorization: `Bearer ${token}` },
        params: { id: `terminal-${index}` },
      }, res);
      assert.equal(res.statusCode, 409);
      assert.match(res.payload.error, /Cannot mutate terminal queue entry/);
    }
    assert.equal(mock.calls.some((call) => call.method === 'update'), false);
  } finally {
    mock.restore();
  }
});

test('generic queue PATCH treats a repeated terminal status as a read-only no-op', async () => {
  const entry = {
    id: 'terminal-idempotent',
    barber_id: 'barber-1',
    branch_id: 'branch-1',
    status: 'completed',
    service_id: 'service-1',
    service_ids: ['service-1'],
  };
  const mock = installDbMock({
    queue_entries: [{ data: entry, error: null }],
    services: [{ data: [{ id: 'service-1', name: 'Haircut', base_price: 100, duration_minutes: 30 }], error: null }],
  });
  const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);

  try {
    const res = createResponse();
    await barbers.updateQueue({
      app: { get: () => null },
      body: { status: 'completed' },
      headers: { authorization: `Bearer ${token}` },
      params: { id: entry.id },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.idempotent, true);
    assert.equal(res.payload.entry.status, 'completed');
    assert.equal(res.payload.entry.total_duration, 30);
    assert.equal(mock.calls.some((call) => call.method === 'update'), false);
  } finally {
    mock.restore();
  }
});

test('generic queue PATCH detects a concurrent status transition', async () => {
  const mock = installDbMock({
    queue_entries: [
      { data: { id: 'queue-race', barber_id: 'barber-1', branch_id: 'branch-1', status: 'called' }, error: null },
      { data: null, error: null },
    ],
  });
  const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);

  try {
    const res = createResponse();
    await barbers.updateQueue({
      app: { get: () => null },
      body: { status: 'in_progress' },
      headers: { authorization: `Bearer ${token}` },
      params: { id: 'queue-race' },
    }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.error, /changed concurrently/);
  } finally {
    mock.restore();
  }
});

test('dedicated complete endpoint rejects every conflicting terminal state', async () => {
  const conflictingTerminalStatuses = ['cancelled', 'rejected', 'no_show', 'not_in_time'];
  const mock = installDbMock({
    queue_entries: conflictingTerminalStatuses.map((status) => ({
      data: {
        id: `complete-${status}`,
        barber_id: 'barber-1',
        branch_id: 'branch-1',
        status,
        price_override: 100,
      },
      error: null,
    })),
  });
  const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);

  try {
    for (const status of conflictingTerminalStatuses) {
      const res = createResponse();
      await barbers.completeQueueEntry({
        app: { get: () => null },
        body: { payment_method: 'cash' },
        headers: { authorization: `Bearer ${token}` },
        params: { id: `complete-${status}` },
      }, res);
      assert.equal(res.statusCode, 409);
      assert.match(res.payload.error, new RegExp(`from status ${status}`));
    }
    assert.equal(mock.calls.some((call) => call.method === 'update'), false);
  } finally {
    mock.restore();
  }
});

test('dedicated complete endpoint accepts only in_progress as a non-idempotent source status', async () => {
  const invalidSourceStatuses = ['waiting', 'called', 'swapped'];
  const mock = installDbMock({
    queue_entries: invalidSourceStatuses.map((status) => ({
      data: {
        id: `complete-source-${status}`,
        barber_id: 'barber-1',
        branch_id: 'branch-1',
        status,
        price_override: 100,
      },
      error: null,
    })),
  });
  const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);

  try {
    for (const status of invalidSourceStatuses) {
      const res = createResponse();
      await barbers.completeQueueEntry({
        app: { get: () => null },
        body: { payment_method: 'cash' },
        headers: { authorization: `Bearer ${token}` },
        params: { id: `complete-source-${status}` },
      }, res);
      assert.equal(res.statusCode, 409);
      assert.match(res.payload.error, new RegExp(`from status ${status}`));
    }
    assert.equal(mock.calls.some((call) => call.method === 'update'), false);
  } finally {
    mock.restore();
  }
});

test('dedicated complete endpoint preserves completed retry without rewriting queue status', async () => {
  const entry = {
    id: 'complete-idempotent',
    barber_id: 'barber-1',
    branch_id: null,
    client_id: null,
    status: 'completed',
    service_id: null,
    service_ids: [],
    payment_method: null,
    price_override: null,
  };
  const mock = installDbMock({
    queue_entries: [{ data: entry, error: null }],
    payments: [{ data: [], error: null }],
    marketplace_booking_persons: [{ data: [], error: null }],
  });
  const originalConnect = pool.connect;
  pool.connect = async () => ({
    query: async () => ({ rows: [] }),
    release() {},
  });
  const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);

  try {
    const res = createResponse();
    await barbers.completeQueueEntry({
      app: { get: () => null },
      body: {},
      headers: { authorization: `Bearer ${token}` },
      params: { id: entry.id },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.entry.status, 'completed');
    assert.equal(mock.calls.some((call) => call.method === 'update' && call.table === 'queue_entries'), false);
  } finally {
    pool.connect = originalConnect;
    mock.restore();
  }
});

test('dedicated complete endpoint uses prior status as CAS and rejects a concurrent terminal transition', async () => {
  const entry = {
    id: 'complete-race',
    barber_id: 'barber-1',
    branch_id: 'branch-1',
    client_id: null,
    status: 'in_progress',
    price_override: 100,
  };
  const mock = installDbMock({
    queue_entries: [
      { data: entry, error: null },
      { data: null, error: null },
    ],
  });
  const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);

  try {
    const res = createResponse();
    await barbers.completeQueueEntry({
      app: { get: () => null },
      body: { payment_method: 'cash' },
      headers: { authorization: `Bearer ${token}` },
      params: { id: entry.id },
    }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.error, /changed concurrently/);
    assert.equal(mock.calls.some((call) => (
      call.method === 'eq'
      && call.table === 'queue_entries'
      && call.column === 'status'
      && call.value === 'in_progress'
    )), true);
  } finally {
    mock.restore();
  }
});

test('PATCH /api/barbers/queue/:id/no-show is owner-scoped, guarded, idempotent, and realtime', async () => {
  const baseEntry = { id: 'queue-1', client_id: 'client-1', barber_id: 'barber-1', branch_id: 'branch-1', status: 'called', finished_at: null };
  const noShowEntry = { ...baseEntry, status: 'no_show', finished_at: new Date().toISOString() };
  const mock = installDbMock({
    queue_entries: [
      { data: baseEntry, error: null },
      { data: noShowEntry, error: null },
      { data: noShowEntry, error: null },
      { data: { ...baseEntry, status: 'completed' }, error: null },
    ],
  });
  const emitted = [];
  const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);
  const req = {
    app: { get: () => ({ to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }) }) },
    body: {},
    headers: { authorization: `Bearer ${token}` },
    params: { id: 'queue-1' },
  };

  try {
    const first = createResponse();
    await barbers.markNoShow(req, first);
    assert.equal(first.statusCode, 200);
    assert.equal(first.payload.idempotent, false);
    assert.equal(first.payload.queue_entry.status, 'no_show');
    assert.equal(emitted[0].payload.type, 'queue_no_show');

    const retry = createResponse();
    await barbers.markNoShow(req, retry);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.payload.idempotent, true);
    assert.equal(emitted.length, 1);

    const terminal = createResponse();
    await barbers.markNoShow(req, terminal);
    assert.equal(terminal.statusCode, 409);
    assert.match(terminal.payload.error, /completed.*no_show/);
    assert.equal(emitted.length, 1);

    const update = mock.calls.find((call) => call.method === 'update' && call.table === 'queue_entries');
    assert.equal(update.value.status, 'no_show');
    assert.ok(mock.calls.some((call) => call.method === 'eq' && call.column === 'barber_id' && call.value === 'barber-1'));
  } finally {
    mock.restore();
  }
});

test('PATCH /api/barbers/queue/:id/not-in-time is owner-scoped, guarded, idempotent, and realtime', async () => {
  const baseEntry = { id: 'queue-1', client_id: 'client-1', barber_id: 'barber-1', branch_id: 'branch-1', status: 'called', finished_at: null };
  const notInTimeEntry = { ...baseEntry, status: 'not_in_time', finished_at: new Date().toISOString() };
  const mock = installDbMock({
    queue_entries: [
      { data: baseEntry, error: null },
      { data: notInTimeEntry, error: null },
      { data: notInTimeEntry, error: null },
      { data: { ...baseEntry, status: 'completed' }, error: null },
    ],
  });
  const emitted = [];
  const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);
  const req = {
    app: { get: () => ({ to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }) }) },
    body: {},
    headers: { authorization: `Bearer ${token}` },
    params: { id: 'queue-1' },
  };

  try {
    const unauthorized = createResponse();
    await barbers.markNotInTime({ ...req, headers: {} }, unauthorized);
    assert.equal(unauthorized.statusCode, 401);

    const first = createResponse();
    await barbers.markNotInTime(req, first);
    assert.equal(first.statusCode, 200);
    assert.equal(first.payload.idempotent, false);
    assert.equal(first.payload.queue_entry.status, 'not_in_time');
    assert.equal(emitted[0].event, 'queue:update');
    assert.equal(emitted[0].payload.type, 'queue_not_in_time');

    const retry = createResponse();
    await barbers.markNotInTime(req, retry);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.payload.idempotent, true);
    assert.equal(emitted.length, 1);

    const terminal = createResponse();
    await barbers.markNotInTime(req, terminal);
    assert.equal(terminal.statusCode, 409);
    assert.match(terminal.payload.error, /completed.*not_in_time/);
    assert.equal(emitted.length, 1);

    const update = mock.calls.find((call) => call.method === 'update' && call.table === 'queue_entries');
    assert.equal(update.value.status, 'not_in_time');
    assert.ok(mock.calls.some((call) => call.method === 'eq' && call.column === 'barber_id' && call.value === 'barber-1'));
  } finally {
    mock.restore();
  }
});

test('GET /api/barbers/queue/:id/barber-history returns an ordered PII-free barber path', async () => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    if (/from queue_entries q/i.test(sql)) {
      return { rows: [{ id: 'queue-1', status: 'waiting', branch_id: 'branch-1', barber_id: 'barber-c', current_barber_name: 'Barber C' }] };
    }
    if (/from queue_transfer_events t/i.test(sql)) {
      return { rows: [
        { id: 'transfer-1', from_barber_id: 'barber-a', from_barber_name: 'Barber A', to_barber_id: 'barber-b', to_barber_name: 'Barber B', status: 'accepted', original_status: 'called', requested_at: '2026-10-03T10:00:00Z' },
        { id: 'transfer-2', from_barber_id: 'barber-b', from_barber_name: 'Barber B', to_barber_id: 'barber-c', to_barber_name: 'Barber C', status: 'accepted', original_status: 'waiting', requested_at: '2026-10-03T11:00:00Z' },
      ] };
    }
    if (/from queue_status_events e/i.test(sql)) {
      return { rows: [{ id: 1, from_status: null, to_status: 'waiting', barber_id: 'barber-a', barber_name: 'Barber A', occurred_at: '2026-10-03T09:00:00Z' }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };

  try {
    const token = jwt.sign({ sub: 'barber-c', role: 'barber', branch_id: 'branch-1' }, process.env.JWT_SECRET);
    const req = { headers: { authorization: `Bearer ${token}` }, params: { id: 'queue-1' } };
    const res = createResponse();
    await queueTransfers.history(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.entry.barber_path.map((barber) => barber.id), ['barber-a', 'barber-b', 'barber-c']);
    assert.equal(res.payload.entry.original_barber.name, 'Barber A');
    assert.equal(res.payload.entry.current_barber.name, 'Barber C');
    assert.equal(res.payload.transfers.length, 2);
    assert.equal(res.payload.status_history.length, 1);
    assert.equal(JSON.stringify(res.payload).includes('client'), false);
  } finally {
    pool.query = originalQuery;
  }
});

test.after(async () => {
  await pool.end();
});
