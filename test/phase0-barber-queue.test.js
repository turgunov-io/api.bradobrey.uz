const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.PGDATABASE ||= 'phase0-barber-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'phase0-barber-tests';
process.env.JWT_SECRET ||= 'phase0-barber-test-secret';

const { db, pool } = require('../src/config/postgres');
const barbers = require('../src/models/barbers');

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
  return { calls, restore() { db.from = originalFrom; } };
}

function installSessionMock(sessionRow) {
  const originalQuery = pool.query;
  const sql = [];
  pool.query = async (text) => {
    sql.push(String(text));
    return { rows: sessionRow ? [sessionRow] : [] };
  };
  return { sql, restore() { pool.query = originalQuery; } };
}

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

const VALID_SESSION = {
  session_id: 'session-1',
  session_expires_at: new Date(Date.now() + 60_000).toISOString(),
  is_expired: false,
  role: 'barber',
  is_archived: false,
  branch_is_active: true,
  branch_access_revoked: false,
};

const sessionToken = (overrides = {}) => jwt.sign({
  sub: 'barber-1', role: 'barber', branchId: 'branch-1', jti: 'session-1', ...overrides,
}, process.env.JWT_SECRET);

const requestWith = (token, extra = {}) => ({
  headers: { authorization: `Bearer ${token}` }, query: {}, params: {}, body: {}, ...extra,
});

// ---- 0.9 myQueue / getQueueById must verify the persisted session ----

test('myQueue rejects a JWT without a session id (jti/branchId) before touching the queue', async () => {
  const mock = installDbMock({});
  const session = installSessionMock(VALID_SESSION);
  try {
    const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);
    const res = createResponse();
    await barbers.myQueue(requestWith(token), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'SESSION_INVALID');
    assert.equal(mock.calls.some((call) => call.table === 'queue_entries'), false);
  } finally {
    mock.restore();
    session.restore();
  }
});

test('myQueue rejects a revoked session (logged out / replaced jti)', async () => {
  const mock = installDbMock({});
  const session = installSessionMock({ ...VALID_SESSION, session_id: 'newer-session' });
  try {
    const res = createResponse();
    await barbers.myQueue(requestWith(sessionToken()), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'SESSION_REVOKED');
    assert.equal(mock.calls.some((call) => call.table === 'queue_entries'), false);
  } finally {
    mock.restore();
    session.restore();
  }
});

test('myQueue serves the queue for a valid persisted session', async () => {
  const mock = installDbMock({ queue_entries: [{ data: [], error: null }, { data: [], error: null }] });
  const session = installSessionMock(VALID_SESSION);
  try {
    const res = createResponse();
    await barbers.myQueue(requestWith(sessionToken()), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.count, 0);
    assert.match(session.sql.join('\n'), /employee_active_branches/);
  } finally {
    mock.restore();
    session.restore();
  }
});

test('myQueue is scoped to the session branch as well as the barber (like getQueueById)', async () => {
  const mock = installDbMock({ queue_entries: [{ data: [], error: null }, { data: [], error: null }] });
  const session = installSessionMock(VALID_SESSION);
  try {
    const res = createResponse();
    await barbers.myQueue(requestWith(sessionToken()), res);
    assert.equal(res.statusCode, 200);
    const selectIndex = mock.calls.findIndex((call) => call.table === 'queue_entries' && call.method === 'select' && /client:clients/.test(call.value));
    assert.ok(selectIndex >= 0);
    const filters = mock.calls.slice(selectIndex).filter((call) => call.table === 'queue_entries' && call.method === 'eq');
    assert.ok(filters.some((call) => call.column === 'barber_id' && call.value === 'barber-1'));
    assert.ok(filters.some((call) => call.column === 'branch_id' && call.value === 'branch-1'));
  } finally {
    mock.restore();
    session.restore();
  }
});

test('getQueueById rejects a JWT without a persisted session', async () => {
  const mock = installDbMock({});
  const session = installSessionMock(null);
  try {
    const res = createResponse();
    await barbers.getQueueById(requestWith(sessionToken(), { params: { id: 'queue-1' } }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(mock.calls.some((call) => call.table === 'queue_entries'), false);
  } finally {
    mock.restore();
    session.restore();
  }
});

test('getQueueById is scoped to the token barber and the session branch', async () => {
  const entry = { id: 'queue-1', status: 'waiting', branch_id: 'branch-1', client: { id: 'c1', name: 'C', phone: '+998' } };
  const mock = installDbMock({
    queue_entries: [{ data: entry, error: null }],
    promo_code_usage: [{ data: [], error: null }],
    cashback_transactions: [{ data: [], error: null }],
  });
  const session = installSessionMock(VALID_SESSION);
  try {
    const res = createResponse();
    await barbers.getQueueById(requestWith(sessionToken(), { params: { id: 'queue-1' } }), res);
    assert.equal(res.statusCode, 200);
    const filters = mock.calls.filter((call) => call.method === 'eq' && call.table === 'queue_entries');
    assert.deepEqual(
      filters.map((call) => [call.column, call.value]),
      [['id', 'queue-1'], ['barber_id', 'barber-1'], ['branch_id', 'branch-1']],
    );
  } finally {
    mock.restore();
    session.restore();
  }
});

test('getQueueById returns 404 for an entry outside the session branch', async () => {
  const mock = installDbMock({ queue_entries: [{ data: null, error: null }] });
  const session = installSessionMock(VALID_SESSION);
  try {
    const res = createResponse();
    await barbers.getQueueById(requestWith(sessionToken(), { params: { id: 'queue-other-branch' } }), res);
    assert.equal(res.statusCode, 404);
  } finally {
    mock.restore();
    session.restore();
  }
});

// ---- 0.8 queue services must belong to the entry branch (or be network-wide) ----

test('updateQueue rejects a service that belongs to another branch', async () => {
  const entry = { id: 'queue-1', barber_id: 'barber-1', status: 'waiting', branch_id: 'branch-1', service_id: 'svc-a', service_ids: ['svc-a'] };
  const mock = installDbMock({
    queue_entries: [{ data: entry, error: null }],
    services: [{ data: [{ id: 'svc-foreign', name: 'Foreign', base_price: 1, duration_minutes: 10, is_active: true, branch_id: 'branch-2' }], error: null }],
  });
  const session = installSessionMock(VALID_SESSION);
  try {
    const res = createResponse();
    await barbers.updateQueue(requestWith(sessionToken(), {
      params: { id: 'queue-1' },
      body: { service_ids: ['svc-foreign'] },
    }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /service_ids are invalid/);
    assert.equal(mock.calls.some((call) => call.method === 'update'), false);
  } finally {
    mock.restore();
    session.restore();
  }
});

test('updateQueue rejects a foreign-branch service passed as a single service_id', async () => {
  const entry = { id: 'queue-1', barber_id: 'barber-1', status: 'waiting', branch_id: 'branch-1', service_id: 'svc-a', service_ids: ['svc-a'] };
  const mock = installDbMock({
    queue_entries: [{ data: entry, error: null }],
    services: [{ data: [{ id: 'svc-foreign', base_price: 1, branch_id: 'branch-2' }], error: null }],
  });
  const session = installSessionMock(VALID_SESSION);
  try {
    const res = createResponse();
    await barbers.updateQueue(requestWith(sessionToken(), {
      params: { id: 'queue-1' },
      body: { service_id: 'svc-foreign' },
    }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(mock.calls.some((call) => call.method === 'update'), false);
  } finally {
    mock.restore();
    session.restore();
  }
});

// ---- updateQueue / editBeforeComplete must verify the persisted session ----

const QUEUE_WRITE_HANDLERS = [
  ['updateQueue', { status: 'called' }],
  ['editBeforeComplete', { amount: 1000, reason: 'discount' }],
];

for (const [handler, body] of QUEUE_WRITE_HANDLERS) {
  test(`${handler} rejects a JWT without a session id before touching the queue`, async () => {
    const mock = installDbMock({});
    const session = installSessionMock(VALID_SESSION);
    try {
      const token = jwt.sign({ sub: 'barber-1', role: 'barber' }, process.env.JWT_SECRET);
      const res = createResponse();
      await barbers[handler](requestWith(token, { params: { id: 'queue-1' }, body }), res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.payload.code, 'SESSION_INVALID');
      assert.equal(mock.calls.some((call) => call.table === 'queue_entries'), false);
    } finally {
      mock.restore();
      session.restore();
    }
  });

  test(`${handler} rejects a revoked session`, async () => {
    const mock = installDbMock({});
    const session = installSessionMock({ ...VALID_SESSION, session_id: 'newer-session' });
    try {
      const res = createResponse();
      await barbers[handler](requestWith(sessionToken(), { params: { id: 'queue-1' }, body }), res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.payload.code, 'SESSION_REVOKED');
      assert.equal(mock.calls.some((call) => call.table === 'queue_entries'), false);
    } finally {
      mock.restore();
      session.restore();
    }
  });

  test(`${handler} is scoped to the token barber and the session branch`, async () => {
    const mock = installDbMock({ queue_entries: [{ data: null, error: null }] });
    const session = installSessionMock(VALID_SESSION);
    try {
      const res = createResponse();
      await barbers[handler](requestWith(sessionToken(), { params: { id: 'queue-other-branch' }, body }), res);
      assert.equal(res.statusCode, 404);
      const filters = mock.calls.filter((call) => call.method === 'eq' && call.table === 'queue_entries');
      assert.deepEqual(
        filters.map((call) => [call.column, call.value]),
        [['id', 'queue-other-branch'], ['barber_id', 'barber-1'], ['branch_id', 'branch-1']],
      );
      assert.equal(mock.calls.some((call) => call.method === 'update'), false);
    } finally {
      mock.restore();
      session.restore();
    }
  });
}
