const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.PGDATABASE ||= 'queue-transfer-notification-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'queue-transfer-notification-tests';
process.env.JWT_SECRET ||= 'queue-transfer-notification-secret';

const { db, pool } = require('../src/config/postgres');
const queueTransfers = require('../src/models/queueTransfers');
const notificationModel = require('../src/models/notifications');
const marketplacePush = require('../src/services/marketplacePush');

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function transferRow(overrides = {}) {
  return {
    id: 'transfer-1',
    queue_entry_id: 'entry-1',
    from_barber_id: 'barber-a',
    to_barber_id: 'barber-b',
    branch_id: 'branch-1',
    status: 'pending',
    original_status: 'called',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function installTransactionClient(transfer) {
  const calls = [];
  const updatedOrder = {
    id: transfer.queue_entry_id,
    branch_id: transfer.branch_id,
    barber_id: null,
    status: null,
  };
  const client = {
    async query(sql, values = []) {
      const normalized = sql.trim().replace(/\s+/g, ' ').toLowerCase();
      calls.push({ sql: normalized, values });
      if (/^(begin|commit|rollback|savepoint|release savepoint|rollback to savepoint)/.test(normalized)) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('select t.*, q.branch_id')) return { rows: [transfer] };
      if (normalized.startsWith('select greatest(')) return { rows: [{ created_at: new Date().toISOString() }] };
      if (normalized.startsWith('update queue_entries set barber_id=')) {
        updatedOrder.barber_id = values[1];
        updatedOrder.status = values[2];
        return { rows: [updatedOrder] };
      }
      if (normalized.startsWith('update queue_transfer_events set status=')) {
        return { rows: [{ ...transfer, status: values[1], responded_by: values[2], reason: values[3] }] };
      }
      if (normalized.startsWith('insert into notifications')) return { rows: [{ id: 'notification-1' }] };
      throw new Error(`Unexpected query in test: ${normalized}`);
    },
    release() {},
  };
  const originalConnect = pool.connect;
  pool.connect = async () => client;
  return {
    calls,
    restore() { pool.connect = originalConnect; },
  };
}

function makeRequest({ actorId = 'barber-b', role = 'barber', decision = 'accept', reason = null } = {}) {
  const token = jwt.sign({ sub: actorId, role, branchId: 'branch-1' }, process.env.JWT_SECRET);
  const emitted = [];
  return {
    req: {
      headers: { authorization: `Bearer ${token}` },
      params: { transferId: 'transfer-1' },
      body: reason ? { reason } : {},
      query: {},
      app: { get: () => ({ to(room) { return { emit(event, payload) { emitted.push({ room, event, payload }); } }; } }) },
    },
    emitted,
  };
}

test('accept notifies only the initiating employee and keeps branch refresh generic', async () => {
  const dbMock = installTransactionClient(transferRow());
  const originalPush = notificationModel.sendQueueTransferPush;
  const pushes = [];
  notificationModel.sendQueueTransferPush = async (payload) => { pushes.push(payload); return { delivered: 1 }; };
  try {
    const { req, emitted } = makeRequest({ decision: 'accept' });
    const res = response();
    await queueTransfers.accept(req, res);
    await new Promise(setImmediate);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(emitted.map(({ room, payload }) => [room, payload.type]), [
      ['branch:branch-1', 'queue_updated'],
      ['employee:barber-a', 'transfer_accepted'],
    ]);
    assert.equal(emitted[1].payload.fromBarberId, 'barber-a');
    assert.equal(emitted[1].payload.toBarberId, 'barber-b');
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].userId, 'barber-a');
    assert.equal(dbMock.calls.find((call) => call.sql.startsWith('insert into notifications')).values[0], 'barber-a');
    assert.ok(dbMock.calls.findIndex((call) => call.sql === 'commit') < dbMock.calls.length);
  } finally {
    dbMock.restore();
    notificationModel.sendQueueTransferPush = originalPush;
  }
});

test('reject notifies the initiator and includes only a bounded, control-character-free reason', async () => {
  const dbMock = installTransactionClient(transferRow());
  const originalPush = notificationModel.sendQueueTransferPush;
  let pushed;
  notificationModel.sendQueueTransferPush = async (payload) => { pushed = payload; return { delivered: 1 }; };
  try {
    const { req, emitted } = makeRequest({ decision: 'reject', reason: `Needs\nreview ${'x'.repeat(300)}` });
    const res = response();
    await queueTransfers.reject(req, res);
    await new Promise(setImmediate);

    assert.equal(res.statusCode, 200);
    assert.equal(emitted.at(-1).room, 'employee:barber-a');
    assert.equal(emitted.at(-1).payload.type, 'transfer_rejected');
    assert.equal(emitted.at(-1).payload.reason.length, 240);
    assert.doesNotMatch(emitted.at(-1).payload.reason, /[\r\n\u0000-\u001f]/);
    assert.equal(pushed.userId, 'barber-a');
    assert.equal(pushed.status, 'rejected');
  } finally {
    dbMock.restore();
    notificationModel.sendQueueTransferPush = originalPush;
  }
});

test('invalid auth and a non-target responder cannot change or notify the transfer', async () => {
  const originalConnect = pool.connect;
  let connectCount = 0;
  pool.connect = async () => { connectCount += 1; throw new Error('should not connect'); };
  try {
    const invalidRes = response();
    await queueTransfers.accept({ headers: {}, params: { transferId: 'transfer-1' } }, invalidRes);
    assert.equal(invalidRes.statusCode, 401);
    assert.equal(connectCount, 0);
  } finally {
    pool.connect = originalConnect;
  }

  const dbMock = installTransactionClient(transferRow({ to_barber_id: 'barber-c' }));
  try {
    const { req, emitted } = makeRequest({ actorId: 'barber-b' });
    const res = response();
    await queueTransfers.accept(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(emitted.length, 0);
    assert.ok(dbMock.calls.some((call) => call.sql === 'rollback'));
  } finally {
    dbMock.restore();
  }
});

test('same decision retry is idempotent and does not emit or send a second notification', async () => {
  const dbMock = installTransactionClient(transferRow({ status: 'accepted' }));
  const originalPush = notificationModel.sendQueueTransferPush;
  let pushCount = 0;
  notificationModel.sendQueueTransferPush = async () => { pushCount += 1; };
  try {
    const { req, emitted } = makeRequest({ decision: 'accept' });
    const res = response();
    await queueTransfers.accept(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.idempotent, true);
    assert.equal(emitted.length, 0);
    assert.equal(pushCount, 0);
    assert.equal(dbMock.calls.some((call) => call.sql.startsWith('insert into notifications')), false);
  } finally {
    dbMock.restore();
    notificationModel.sendQueueTransferPush = originalPush;
  }
});

test('push provider failure is detached from the already committed transfer outcome', async () => {
  const dbMock = installTransactionClient(transferRow());
  const originalPush = notificationModel.sendQueueTransferPush;
  notificationModel.sendQueueTransferPush = async () => { throw Object.assign(new Error('provider down'), { code: 'messaging/unavailable' }); };
  try {
    const { req } = makeRequest({ decision: 'accept' });
    const res = response();
    await queueTransfers.accept(req, res);
    await new Promise(setImmediate);
    assert.equal(res.statusCode, 200);
    assert.ok(dbMock.calls.some((call) => call.sql === 'commit'));
  } finally {
    dbMock.restore();
    notificationModel.sendQueueTransferPush = originalPush;
  }
});

test('missing employee FCM token is diagnosed without failing notification dispatch', async () => {
  const originalQuery = db.query;
  const originalSend = marketplacePush.sendFcmNotification;
  const originalWarn = console.warn;
  const warnings = [];
  let sendCount = 0;
  db.query = async () => ({ rows: [] });
  marketplacePush.sendFcmNotification = async () => { sendCount += 1; return { delivered: true }; };
  console.warn = (...args) => warnings.push(args);
  try {
    const result = await notificationModel.sendQueueTransferPush({
      userId: 'barber-a', transferId: 'transfer-1', entryId: 'entry-1', status: 'accepted',
      fromBarberId: 'barber-a', toBarberId: 'barber-b', branchId: 'branch-1',
    });
    assert.deepEqual(result, { delivered: 0, reason: 'no_registered_tokens' });
    assert.equal(sendCount, 0);
    assert.match(JSON.stringify(warnings), /no_registered_tokens/);
    assert.doesNotMatch(JSON.stringify(warnings), /token-value/);
  } finally {
    db.query = originalQuery;
    marketplacePush.sendFcmNotification = originalSend;
    console.warn = originalWarn;
  }
});

test('outcome recovery endpoint is restricted to the authenticated initiator', async () => {
  const originalQuery = pool.query;
  let query;
  pool.query = async (sql, values) => {
    query = { sql: sql.replace(/\s+/g, ' '), values };
    return { rows: [{
      transfer_id: 'transfer-1', entry_id: 'entry-1', status: 'rejected',
      from_barber_id: 'barber-a', to_barber_id: 'barber-b', branch_id: 'branch-1',
      responded_at: new Date().toISOString(), reason: 'client asked to wait\nplease',
    }] };
  };
  try {
    const { req } = makeRequest({ actorId: 'barber-a' });
    const res = response();
    await queueTransfers.outcomes(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(query.values[0], 'barber-a');
    assert.match(query.sql, /t\.from_barber_id = \$1/);
    assert.equal(res.payload.items[0].reason, 'client asked to wait please');
  } finally {
    pool.query = originalQuery;
  }
});

test('FCM token registration requires employee auth and upserts only the authenticated owner', async () => {
  const originalQuery = db.query;
  let query;
  db.query = async (sql, values) => { query = { sql: sql.replace(/\s+/g, ' '), values }; return { rows: [] }; };
  try {
    const invalid = response();
    await notificationModel.notifications.saveFcmToken({ headers: {}, body: { token: 'opaque-fcm-token', platform: 'ANDROID' } }, invalid);
    assert.equal(invalid.statusCode, 401);
    assert.equal(query, undefined);

    const { req } = makeRequest({ actorId: 'barber-a' });
    req.body = { token: 'opaque-fcm-token', platform: 'ANDROID' };
    const res = response();
    await notificationModel.notifications.saveFcmToken(req, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.payload.registered, true);
    assert.match(query.sql, /on conflict \(token\) do update/);
    assert.deepEqual(query.values, ['opaque-fcm-token', 'barber-a', 'ANDROID']);
  } finally {
    db.query = originalQuery;
  }
});
