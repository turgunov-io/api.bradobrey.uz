const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
process.env.PGDATABASE ||= 'web-push-notification-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'web-push-notification-tests';
process.env.PGPASSWORD ||= 'unit-test-only';
process.env.JWT_SECRET ||= 'web-push-notification-tests';
const { db } = require('../src/config/postgres');
const { notifications } = require('../src/models/notifications');

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function request({ userId = 'user-a', endpoint, authorized = true } = {}) {
  const token = jwt.sign({ sub: userId, role: 'admin' }, process.env.JWT_SECRET);
  return {
    headers: authorized ? { authorization: `Bearer ${token}` } : {},
    body: endpoint === undefined ? {} : { endpoint },
  };
}

test('browser subscription status is authenticated and scoped to the current user and endpoint', async () => {
  const originalQuery = db.query;
  const originalSetVapidDetails = webpush.setVapidDetails;
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  webpush.setVapidDetails = () => {};
  let query;
  db.query = async (sql, values) => { query = { sql, values }; return { rows: [{ id: 'subscription-a' }] }; };
  try {
    const unauthorized = response();
    await notifications.pushSubscriptionStatus(request({ authorized: false, endpoint: 'https://push.example/device-a' }), unauthorized);
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(query, undefined);

    const authorized = response();
    await notifications.pushSubscriptionStatus(request({ userId: 'user-a', endpoint: 'https://push.example/device-a' }), authorized);
    assert.equal(authorized.payload.registered, true);
    assert.equal(authorized.payload.available, true);
    assert.match(query.sql, /where user_id = \$1 and endpoint = \$2/);
    assert.deepEqual(query.values, ['user-a', 'https://push.example/device-a']);
    assert.equal(JSON.stringify(authorized.payload).includes('push.example'), false);
  } finally {
    db.query = originalQuery;
    webpush.setVapidDetails = originalSetVapidDetails;
  }
});

test('browser push readiness can be checked before asking the user for notification permission', async () => {
  const originalSetVapidDetails = webpush.setVapidDetails;
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  webpush.setVapidDetails = () => {};
  try {
    const res = response();
    await notifications.pushSubscriptionStatus(request(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, { available: true, registered: false });
  } finally {
    webpush.setVapidDetails = originalSetVapidDetails;
  }
});

test('test push sends only to the authenticated user subscription selected in the browser', async () => {
  const originalQuery = db.query;
  const originalSetVapidDetails = webpush.setVapidDetails;
  const originalSendNotification = webpush.sendNotification;
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  const deliveries = [];
  let query;
  webpush.setVapidDetails = () => {};
  webpush.sendNotification = async (subscription) => { deliveries.push(subscription.endpoint); };
  db.query = async (sql, values) => {
    query = { sql, values };
    return { rows: [{ id: 'subscription-a', endpoint: values[1], p256dh: 'public-key', auth: 'auth-secret' }] };
  };
  try {
    const res = response();
    await notifications.testPush(request({ userId: 'user-a', endpoint: 'https://push.example/device-a' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.sent, 1);
    assert.match(query.sql, /where user_id = \$1 and endpoint = \$2/);
    assert.deepEqual(query.values, ['user-a', 'https://push.example/device-a']);
    assert.deepEqual(deliveries, ['https://push.example/device-a']);
  } finally {
    db.query = originalQuery;
    webpush.setVapidDetails = originalSetVapidDetails;
    webpush.sendNotification = originalSendNotification;
  }
});

test('test push does not fall back to other devices when the selected endpoint is not registered', async () => {
  const originalQuery = db.query;
  const originalSetVapidDetails = webpush.setVapidDetails;
  const originalSendNotification = webpush.sendNotification;
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  let query;
  let delivered = false;
  webpush.setVapidDetails = () => {};
  webpush.sendNotification = async () => { delivered = true; };
  db.query = async (sql, values) => { query = { sql, values }; return { rows: [] }; };
  try {
    const res = response();
    await notifications.testPush(request({ userId: 'user-a', endpoint: 'https://push.example/unregistered' }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.payload.found, 0);
    assert.match(query.sql, /where user_id = \$1 and endpoint = \$2/);
    assert.equal(delivered, false);
  } finally {
    db.query = originalQuery;
    webpush.setVapidDetails = originalSetVapidDetails;
    webpush.sendNotification = originalSendNotification;
  }
});
