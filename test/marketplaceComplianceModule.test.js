const test = require('node:test');
const assert = require('node:assert/strict');

test('marketplace compliance module loads referral and review handlers', () => {
  process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
  process.env.JWT_SECRET ||= 'marketplace-compliance-test-secret';
  const compliance = require('../src/models/marketplace/compliance');
  assert.equal(typeof compliance.referral, 'function');
  assert.equal(typeof compliance.getReview, 'function');
  assert.equal(typeof compliance.createReview, 'function');
  assert.equal(typeof compliance.updateReview, 'function');
  assert.equal(typeof compliance.cancelBooking, 'function');
});

const makeResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

const makeRequest = ({ clientId, query = {}, body = {} }) => {
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ sub: clientId, role: 'marketplace' }, process.env.JWT_SECRET);
  return {
    headers: { authorization: `Bearer ${token}` },
    query,
    body,
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };
};

test('GET review is scoped to the authenticated marketplace client', async () => {
  const compliance = require('../src/models/marketplace/compliance');
  const { pool } = require('../src/config/postgres');
  const clientId = '11111111-1111-4111-8111-111111111111';
  const bookingId = '22222222-2222-4222-8222-222222222222';
  const review = { id: '33333333-3333-4333-8333-333333333333', marketplace_client_id: clientId, booking_id: bookingId, rating: 4 };
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('select id, is_active from marketplace_clients')) {
      return { rows: [{ id: clientId, is_active: true }] };
    }
    return { rows: [review] };
  };
  try {
    const response = makeResponse();
    await compliance.getReview(makeRequest({
      clientId,
      query: { booking_id: bookingId, user_id: '99999999-9999-4999-8999-999999999999' },
    }), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { review, reviews: [review] });
    const reviewCall = calls.find((call) => call.sql.includes('from marketplace_reviews'));
    assert.match(reviewCall.sql, /marketplace_client_id\s*=\s*\$1/i);
    assert.deepEqual(reviewCall.params, [clientId, bookingId, null]);
  } finally {
    pool.query = originalQuery;
  }
});

test('GET review resolves a queue entry id to its Marketplace booking', async () => {
  const compliance = require('../src/models/marketplace/compliance');
  const { pool } = require('../src/config/postgres');
  const clientId = '11111111-1111-4111-8111-111111111111';
  const queueEntryId = '22222222-2222-4222-8222-222222222222';
  const bookingId = '44444444-4444-4444-8444-444444444444';
  const review = {
    id: '33333333-3333-4333-8333-333333333333',
    marketplace_client_id: clientId,
    booking_id: bookingId,
    rating: 4,
  };
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('select id, is_active from marketplace_clients')) {
      return { rows: [{ id: clientId, is_active: true }] };
    }
    return { rows: [review] };
  };
  try {
    const response = makeResponse();
    await compliance.getReview(makeRequest({
      clientId,
      query: { booking_id: queueEntryId },
    }), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { review, reviews: [review] });
    const reviewCall = calls.find((call) => call.sql.includes('from marketplace_reviews'));
    assert.match(reviewCall.sql, /queue_entry_id\s*=\s*\$2/i);
    assert.deepEqual(reviewCall.params, [clientId, queueEntryId, null]);
  } finally {
    pool.query = originalQuery;
  }
});

test('re-saving an owned review updates it without trusting a client user id', async () => {
  const compliance = require('../src/models/marketplace/compliance');
  const { pool } = require('../src/config/postgres');
  const clientId = '11111111-1111-4111-8111-111111111111';
  const bookingId = '22222222-2222-4222-8222-222222222222';
  const reviewId = '33333333-3333-4333-8333-333333333333';
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const dbCalls = [];
  pool.query = async (sql, params) => {
    if (sql.includes('select id, is_active from marketplace_clients')) {
      return { rows: [{ id: clientId, is_active: true }] };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  };
  pool.connect = async () => ({
    async query(sql, params) {
      dbCalls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('select id from marketplace_bookings')) return { rows: [{ id: bookingId }] };
      if (sql.includes('select br.marketplace_barbershop_id')) return { rows: [{ barbershop_id: null, barber_id: null }] };
      if (sql.includes('select * from marketplace_reviews')) return { rows: [{ id: reviewId }] };
      if (sql.includes('update marketplace_reviews')) {
        return { rows: [{ id: reviewId, marketplace_client_id: clientId, booking_id: bookingId, rating: 4, comment: 'updated' }] };
      }
      if (sql.includes('insert into marketplace_audit_logs')) return { rows: [] };
      throw new Error(`Unexpected database query: ${sql}`);
    },
    release() {},
  });
  try {
    const response = makeResponse();
    await compliance.createReview(makeRequest({
      clientId,
      body: {
        booking_id: bookingId,
        rating: 4,
        comment: 'updated',
        user_id: '99999999-9999-4999-8999-999999999999',
      },
    }), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.review.id, reviewId);
    assert.equal(dbCalls.filter((call) => call.sql.includes('insert into marketplace_reviews')).length, 0);
    const updateCall = dbCalls.find((call) => call.sql.includes('update marketplace_reviews'));
    assert.deepEqual(updateCall.params, [4, 'updated', reviewId, clientId]);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
});

test('replaying the same idempotency key returns the stored response without inserting twice', async () => {
  const compliance = require('../src/models/marketplace/compliance');
  const { pool } = require('../src/config/postgres');
  const clientId = '11111111-1111-4111-8111-111111111111';
  const bookingId = '22222222-2222-4222-8222-222222222222';
  const reviewId = '33333333-3333-4333-8333-333333333333';
  const requestId = 'review-request-1';
  const review = { id: reviewId, marketplace_client_id: clientId, booking_id: bookingId, rating: 5, comment: 'ok' };
  const responseBody = { review };
  const payloadHash = require('node:crypto')
    .createHash('md5')
    .update(JSON.stringify({ booking_id: bookingId, service_id: null, rating: 5, comment: 'ok' }))
    .digest('hex');
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  let connectionNumber = 0;
  let reviewInsertCount = 0;
  pool.query = async (sql) => {
    if (sql.includes('select id, is_active from marketplace_clients')) return { rows: [{ id: clientId, is_active: true }] };
    throw new Error(`Unexpected pool query: ${sql}`);
  };
  pool.connect = async () => {
    connectionNumber += 1;
    const currentConnection = connectionNumber;
    let step = 0;
    return {
      async query(sql) {
        step += 1;
        if (sql === 'BEGIN') return { rows: [] };
        if (currentConnection === 2 && step === 2) {
          assert.match(sql, /marketplace_idempotency_requests/);
          return { rows: [{ status: 201, response: responseBody, payload_hash: payloadHash }] };
        }
        if (currentConnection === 2 && step === 3) {
          assert.equal(sql, 'ROLLBACK');
          return { rows: [] };
        }
        if (currentConnection === 1 && sql.includes('select status, response, payload_hash')) return { rows: [] };
        if (currentConnection === 1 && sql.includes('insert into marketplace_idempotency_requests')) return { rows: [] };
        if (currentConnection === 1 && sql.includes('select id from marketplace_bookings')) return { rows: [{ id: bookingId }] };
        if (currentConnection === 1 && sql.includes('select br.marketplace_barbershop_id')) return { rows: [{ barbershop_id: null, barber_id: null }] };
        if (currentConnection === 1 && sql.includes('select * from marketplace_reviews')) return { rows: [] };
        if (currentConnection === 1 && sql.includes('insert into marketplace_reviews')) {
          reviewInsertCount += 1;
          return { rows: [review] };
        }
        if (currentConnection === 1 && sql.includes('insert into marketplace_audit_logs')) return { rows: [] };
        if (currentConnection === 1 && sql.includes('update marketplace_idempotency_requests')) return { rows: [] };
        if (currentConnection === 1 && sql === 'COMMIT') return { rows: [] };
        throw new Error(`Unexpected database query: ${sql}`);
      },
      release() {},
    };
  };
  try {
    const request = makeRequest({
      clientId,
      body: { booking_id: bookingId, rating: 5, comment: 'ok', request_id: requestId },
    });
    const firstResponse = makeResponse();
    await compliance.createReview(request, firstResponse);
    assert.equal(firstResponse.statusCode, 201);
    const replayResponse = makeResponse();
    await compliance.createReview(request, replayResponse);
    assert.equal(replayResponse.statusCode, 201);
    assert.deepEqual(replayResponse.body, responseBody);
    assert.equal(reviewInsertCount, 1);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
});

test('review validation rejects rating outside 1..5 before opening a write transaction', async () => {
  const compliance = require('../src/models/marketplace/compliance');
  const { pool } = require('../src/config/postgres');
  const clientId = '11111111-1111-4111-8111-111111111111';
  const bookingId = '22222222-2222-4222-8222-222222222222';
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  let connected = false;
  pool.query = async (sql) => {
    if (sql.includes('select id, is_active from marketplace_clients')) return { rows: [{ id: clientId, is_active: true }] };
    throw new Error('Unexpected pool query');
  };
  pool.connect = async () => {
    connected = true;
    throw new Error('write transaction must not be opened');
  };
  try {
    const response = makeResponse();
    await compliance.createReview(makeRequest({ clientId, body: { booking_id: bookingId, rating: 0 } }), response);
    assert.equal(response.statusCode, 400);
    assert.equal(connected, false);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
});

test('review migration keeps one legacy review or one review per booking/service', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const migration = fs.readFileSync(
    path.resolve(__dirname, '..', 'db', 'postgres', 'marketplace_tz_compliance.sql'),
    'utf8',
  );
  assert.match(migration, /marketplace_reviews_booking_service_uidx/);
  assert.match(migration, /on marketplace_reviews \(booking_id, service_id\) where service_id is not null/);
  assert.match(migration, /marketplace_reviews_booking_legacy_uidx/);
  assert.match(migration, /on marketplace_reviews \(booking_id\) where service_id is null/);
});
