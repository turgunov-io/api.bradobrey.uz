const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.PGHOST ||= '127.0.0.1';
process.env.PGPORT ||= '5432';
process.env.PGDATABASE ||= 'location-contract-tests';
process.env.PGUSER ||= 'location-contract-tests';
process.env.PGPASSWORD ||= 'unit-test-only';
const { haversineMeters, normalizeLocation, isLocationControlEnabled } = require('../src/services/barberLocation');
const { listLocationEvents } = require('../src/services/barberLocation');
const { db } = require('../src/config/postgres');

test('haversine distance is symmetric and keeps the 1km boundary usable', () => {
  const distance = haversineMeters(41.3111, 69.2797, 41.320083, 69.2797);
  assert.ok(distance > 990 && distance < 1010);
  assert.equal(Math.round(haversineMeters(41.3111, 69.2797, 41.3111, 69.2797)), 0);
});

test('location payload rejects stale, inaccurate, invalid, and mocked positions', () => {
  const base = {
    latitude: 41.3111,
    longitude: 69.2797,
    accuracy_meters: 20,
    measured_at: new Date().toISOString(),
  };
  assert.equal(normalizeLocation(base).error, undefined);
  assert.equal(normalizeLocation({ ...base, latitude: 100 }).error, 'INVALID_COORDINATES');
  assert.equal(normalizeLocation({ ...base, accuracy_meters: 201 }).error, 'LOW_ACCURACY');
  assert.equal(normalizeLocation({ ...base, measured_at: new Date(Date.now() - 3600000).toISOString() }).error, 'STALE_COORDINATES');
  assert.equal(normalizeLocation({ ...base, is_mocked: true }).error, 'MOCKED_COORDINATES');
});

test('location control is skipped until a branch has an enabled location policy', () => {
  assert.equal(isLocationControlEnabled(null), false);
  assert.equal(isLocationControlEnabled({ is_enabled: false }), false);
  assert.equal(isLocationControlEnabled({ is_enabled: true }), true);
});

test('location event lookup filters by exact event and branch', async () => {
  const originalQuery = db.query;
  process.env.JWT_SECRET = 'location-contract-test-secret';
  let query;
  let values;
  db.query = async (sql, params) => {
    query = sql;
    values = params;
    return { rows: [{ id: 'event-42', branch_id: 'branch-7' }] };
  };
  const req = {
    headers: { authorization: `Bearer ${jwt.sign({ role: 'admin_network', sub: 'admin-1' }, process.env.JWT_SECRET)}` },
    query: { branch_id: 'branch-7', event_id: 'event-42', limit: '1' },
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  try {
    await listLocationEvents(req, res);
    assert.match(query, /e\.branch_id = \$1 and e\.id = \$2/);
    assert.deepEqual(values, ['branch-7', 'event-42', 1]);
    assert.equal(res.body.items[0].id, 'event-42');
  } finally {
    db.query = originalQuery;
  }
});

test('branch-scoped location administrators cannot read events outside their branch', async () => {
  const originalQuery = db.query;
  process.env.JWT_SECRET = 'location-contract-test-secret';
  let databaseCalled = false;
  let listQuery;
  let listValues;
  db.query = async (sql, params) => { databaseCalled = true; listQuery = sql; listValues = params; return { rows: [] }; };
  const makeRequest = (query) => ({
    headers: { authorization: `Bearer ${jwt.sign({ role: 'admin_branch', branchId: 'branch-7' }, process.env.JWT_SECRET)}` },
    query,
  });
  const makeResponse = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  try {
    const mismatch = makeResponse();
    await listLocationEvents(makeRequest({ branch_id: 'branch-8', event_id: 'event-42' }), mismatch);
    assert.equal(mismatch.statusCode, 403);
    const unfiltered = makeResponse();
    await listLocationEvents(makeRequest({}), unfiltered);
    assert.equal(unfiltered.statusCode, 200);
    assert.match(listQuery, /where e\.branch_id = \$1/);
    assert.deepEqual(listValues, ['branch-7', 50]);
    assert.equal(databaseCalled, true);
  } finally {
    db.query = originalQuery;
  }
});
