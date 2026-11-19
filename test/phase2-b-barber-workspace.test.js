// Phase 2 (group B) M4: barber workspace handlers that used to verify only the
// JWT signature + role claim (break, return, call, start, complete, profile)
// now require a persisted session (authenticateBarberWorkspace) and scope
// queue writes to the session branch.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'phase2-b-workspace-secret';

const barbers = require('../src/models/barbers');
const { installDbMock, installPoolMock, makeRes, eqCalls } = require('./helpers/tenantMocks');

const BARBER = '30000000-0000-4000-8000-00000000000b';
const SESSION_BRANCH = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';

const VALID_SESSION = {
  session_id: 'session-1',
  session_expires_at: new Date(Date.now() + 3600000).toISOString(),
  is_expired: false,
  role: 'barber',
  is_archived: false,
  branch_is_active: true,
  branch_access_revoked: false,
};

const HANDLERS = ['takeBreak', 'returnFromBreak', 'callNext', 'startQueue', 'completeQueueEntry', 'updateProfile'];

const legacyToken = () => jwt.sign({ sub: BARBER, role: 'barber', branchId: SESSION_BRANCH }, process.env.JWT_SECRET);
const sessionToken = () => jwt.sign({ sub: BARBER, role: 'barber', branchId: SESSION_BRANCH, jti: 'session-1' }, process.env.JWT_SECRET);

const reqWith = (token, extra = {}) => ({
  app: { get: () => null },
  headers: { authorization: `Bearer ${token}` },
  params: { id: 'queue-1' },
  body: {},
  ...extra,
});

test('barber workspace: a token without a persisted session is rejected before any DB write', async () => {
  for (const name of HANDLERS) {
    const mock = installDbMock({});
    const pool = installPoolMock(() => ({ rows: [] }));
    try {
      const res = makeRes();
      await barbers[name](reqWith(legacyToken(), { body: name === 'updateProfile' ? { photo_url: 'https://x/y.png' } : {} }), res);
      assert.equal(res.statusCode, 401, name);
      assert.equal(mock.calls.length, 0, `${name} touched the DB`);
    } finally {
      mock.restore();
      pool.restore();
    }
  }
});

test('barber workspace: a revoked session (archived account) is rejected', async () => {
  for (const name of HANDLERS) {
    const mock = installDbMock({});
    const pool = installPoolMock(() => ({ rows: [{ ...VALID_SESSION, is_archived: true }] }));
    try {
      const res = makeRes();
      await barbers[name](reqWith(sessionToken(), { body: name === 'updateProfile' ? { photo_url: 'https://x/y.png' } : {} }), res);
      assert.equal(res.statusCode, 403, name);
      assert.equal(mock.calls.length, 0, `${name} touched the DB`);
    } finally {
      mock.restore();
      pool.restore();
    }
  }
});

for (const name of ['callNext', 'startQueue', 'completeQueueEntry']) {
  test(`barber workspace: ${name} only finds entries of the session branch`, async () => {
    const mock = installDbMock({ queue_entries: [{ data: null, error: null }] });
    const pool = installPoolMock(() => ({ rows: [VALID_SESSION] }));
    try {
      const res = makeRes();
      await barbers[name](reqWith(sessionToken(), { body: name === 'completeQueueEntry' ? { payment_method: 'cash' } : {} }), res);
      assert.equal(res.statusCode, 404);
      assert.deepEqual(eqCalls(mock.calls, 'queue_entries', 'branch_id'), [SESSION_BRANCH]);
      assert.deepEqual(eqCalls(mock.calls, 'queue_entries', 'barber_id'), [BARBER]);
    } finally {
      mock.restore();
      pool.restore();
    }
  });
}
