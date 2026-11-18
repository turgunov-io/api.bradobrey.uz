const test = require('node:test');
const assert = require('node:assert/strict');

const { createKioskAuth, KIOSK_TOKEN_HEADER, isKioskAuthEnforced } = require('../src/middleware/kioskAuth');

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';
const KIOSK_ID = '33333333-3333-4333-8333-333333333333';
const GOOD_TOKEN = 'good-token';

const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const BRANCH_ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const ARCHIVED_ID = '66666666-6666-4666-8666-666666666666';
const GONE_ID = '77777777-7777-4777-8777-777777777777';
const CLIENT_ID = '88888888-8888-4888-8888-888888888888';

// Bearer tokens by name -> JWT payload. For staff the token role is never
// trusted; STAFF_ROWS (the DB) decides.
const BEARER_PAYLOADS = {
  jwt: { sub: ADMIN_ID, role: 'admin' },
  branchAdmin: { sub: BRANCH_ADMIN_ID, role: 'admin_network' },
  archived: { sub: ARCHIVED_ID, role: 'admin' },
  gone: { sub: GONE_ID, role: 'admin' },
  nonUuid: { sub: 'u1', role: 'admin' },
  marketplace: { sub: CLIENT_ID, role: 'marketplace' },
};
const STAFF_ROWS = {
  [ADMIN_ID]: { user: { id: ADMIN_ID, role: 'admin', branch_id: null }, barber: null },
  [BRANCH_ADMIN_ID]: { user: { id: BRANCH_ADMIN_ID, role: 'admin_branch', branch_id: BRANCH_A }, barber: null },
  [ARCHIVED_ID]: { user: { id: ARCHIVED_ID, role: 'admin', branch_id: null }, barber: { id: ARCHIVED_ID, is_archived: true } },
};

function makeAuth({ enforce = false, warnings = [], bearerOk = true, staffLoads = [] } = {}) {
  return createKioskAuth({
    authenticate: async (token) => (token === GOOD_TOKEN ? { id: KIOSK_ID, branchId: BRANCH_A } : null),
    verifyBearer: (token) => (bearerOk ? BEARER_PAYLOADS[token] || null : null),
    loadStaff: async (userId) => { staffLoads.push(userId); return STAFF_ROWS[userId] || { user: null, barber: null }; },
    isArchived: (barber) => barber?.is_archived === true,
    resolveScope: async (user) => (user.role === 'admin' ? null : [BRANCH_A]),
    env: { KIOSK_AUTH_ENFORCE: enforce ? 'true' : 'false' },
    warn: (...args) => warnings.push(args.join(' ')),
  });
}

function makeReq({ token, bearer, params = {}, body, query = {}, method = 'GET', path = '/services' } = {}) {
  const headers = {};
  if (token !== undefined) headers[KIOSK_TOKEN_HEADER] = token;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return { headers, params, body, query, method, baseUrl: '/api/kiosk', route: { path }, path };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

async function run(middleware, req) {
  const res = makeRes();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('KIOSK_AUTH_ENFORCE defaults to false and accepts common truthy values', () => {
  assert.equal(isKioskAuthEnforced({}), false);
  assert.equal(isKioskAuthEnforced({ KIOSK_AUTH_ENFORCE: 'false' }), false);
  assert.equal(isKioskAuthEnforced({ KIOSK_AUTH_ENFORCE: 'true' }), true);
  assert.equal(isKioskAuthEnforced({ KIOSK_AUTH_ENFORCE: '1' }), true);
});

test('a valid token sets req.kiosk with the kiosk branch', async () => {
  const req = makeReq({ token: GOOD_TOKEN });
  const { res, nextCalled } = await run(makeAuth()(), req);
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(req.kiosk, { id: KIOSK_ID, branchId: BRANCH_A });
});

test('an invalid token is rejected with 401 even in legacy mode', async () => {
  const req = makeReq({ token: 'wrong' });
  const { res, nextCalled } = await run(makeAuth({ enforce: false })(), req);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.code, 'KIOSK_TOKEN_INVALID');
  assert.equal(req.kiosk, undefined);
});

test('a branch_id in params, body or query that differs from the kiosk branch is 403', async () => {
  const auth = makeAuth()();
  for (const req of [
    makeReq({ token: GOOD_TOKEN, params: { branch_id: BRANCH_B } }),
    makeReq({ token: GOOD_TOKEN, body: { branch_id: BRANCH_B }, method: 'POST' }),
    makeReq({ token: GOOD_TOKEN, query: { branch_id: BRANCH_B } }),
  ]) {
    const { res, nextCalled } = await run(auth, req);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'KIOSK_BRANCH_MISMATCH');
  }
});

test('a matching branch_id passes and a missing body branch_id is filled from the kiosk', async () => {
  const auth = makeAuth()();
  const matching = makeReq({ token: GOOD_TOKEN, params: { branch_id: BRANCH_A.toUpperCase() } });
  assert.equal((await run(auth, matching)).nextCalled, true);

  const body = { barber_id: 'b1' };
  const posted = makeReq({ token: GOOD_TOKEN, body, method: 'POST' });
  assert.equal((await run(auth, posted)).nextCalled, true);
  assert.equal(posted.body.branch_id, BRANCH_A);
});

test('legacy mode lets requests without a token through and warns once per path class', async () => {
  const warnings = [];
  const auth = makeAuth({ warnings })();
  assert.equal((await run(auth, makeReq())).nextCalled, true);
  assert.equal((await run(auth, makeReq())).nextCalled, true);
  assert.equal((await run(auth, makeReq({ path: '/book', method: 'POST' }))).nextCalled, true);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /X-Kiosk-Token/);
});

test('enforce mode rejects a missing token with 401', async () => {
  const { res, nextCalled } = await run(makeAuth({ enforce: true })(), makeReq());
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.code, 'KIOSK_TOKEN_REQUIRED');
});

test('enforce mode accepts a valid bearer token only where allowBearer is set', async () => {
  const withBearer = makeAuth({ enforce: true })({ allowBearer: true });
  assert.equal((await run(withBearer, makeReq({ bearer: 'jwt' }))).nextCalled, true);
  assert.equal((await run(withBearer, makeReq({ bearer: 'forged' }))).res.statusCode, 401);

  const kioskOnly = makeAuth({ enforce: true })();
  assert.equal((await run(kioskOnly, makeReq({ bearer: 'jwt' }))).res.statusCode, 401);
});

test('legacy mode does not warn for bearer-authenticated callers', async () => {
  const warnings = [];
  const auth = makeAuth({ warnings })({ allowBearer: true });
  assert.equal((await run(auth, makeReq({ bearer: 'jwt' }))).nextCalled, true);
  assert.equal(warnings.length, 0);
});

test('a token lookup failure answers 500 without calling next', async () => {
  const auth = createKioskAuth({
    authenticate: async () => { throw new Error('db down'); },
    env: {},
    warn: () => {},
    logError: () => {},
  })();
  const { res, nextCalled } = await run(auth, makeReq({ token: GOOD_TOKEN }));
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 500);
});

test('enforce mode rejects a marketplace client token on staff/kiosk-only routes', async () => {
  const auth = makeAuth({ enforce: true })({ allowBearer: true });
  for (const req of [
    makeReq({ bearer: 'marketplace' }),
    makeReq({ bearer: 'marketplace', path: '/barbers/:branch_id', params: { branch_id: BRANCH_A } }),
  ]) {
    const { res, nextCalled } = await run(auth, req);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  }
});

test('enforce mode accepts a marketplace token only where the route allows it', async () => {
  const certificate = makeAuth({ enforce: true })({ allowBearer: true, allowMarketplace: () => true });
  assert.equal((await run(certificate, makeReq({ bearer: 'marketplace', path: '/certificate/:id' }))).nextCalled, true);

  const book = makeAuth({ enforce: true })({ allowBearer: true, allowMarketplace: (req) => req.body?.source === 'site' });
  const site = makeReq({ bearer: 'marketplace', method: 'POST', path: '/book', body: { source: 'site', branch_id: BRANCH_B } });
  assert.equal((await run(book, site)).nextCalled, true);
  const point = makeReq({ bearer: 'marketplace', method: 'POST', path: '/book', body: { source: 'point', branch_id: BRANCH_B } });
  const denied = await run(book, point);
  assert.equal(denied.nextCalled, false);
  assert.equal(denied.res.statusCode, 403);
});

test('enforce mode rejects bearer tokens whose subject is not an active employee in the DB', async () => {
  const auth = makeAuth({ enforce: true })({ allowBearer: true });
  for (const bearer of ['gone', 'archived', 'nonUuid']) {
    const { res, nextCalled } = await run(auth, makeReq({ bearer }));
    assert.equal(nextCalled, false, bearer);
    assert.equal(res.statusCode, 403, bearer);
  }
});

test('enforce mode pins a branch-scoped employee to its allowed branches (DB role, not token role)', async () => {
  const auth = makeAuth({ enforce: true })({ allowBearer: true });
  for (const req of [
    makeReq({ bearer: 'branchAdmin', params: { branch_id: BRANCH_B } }),
    makeReq({ bearer: 'branchAdmin', query: { branch_id: BRANCH_B } }),
    makeReq({ bearer: 'branchAdmin', body: { branch_id: BRANCH_B }, method: 'POST' }),
  ]) {
    const { res, nextCalled } = await run(auth, req);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  }

  const allowed = makeReq({ bearer: 'branchAdmin', params: { branch_id: BRANCH_A } });
  assert.equal((await run(auth, allowed)).nextCalled, true);
  assert.deepEqual(allowed.kioskStaff, { id: BRANCH_ADMIN_ID, role: 'admin_branch', branchScope: [BRANCH_A] });

  const unscoped = makeReq({ bearer: 'branchAdmin' });
  assert.equal((await run(auth, unscoped)).nextCalled, true);
  assert.deepEqual(unscoped.kioskStaff.branchScope, [BRANCH_A]);
});

test('enforce mode leaves network roles unrestricted', async () => {
  const auth = makeAuth({ enforce: true })({ allowBearer: true });
  const req = makeReq({ bearer: 'jwt', params: { branch_id: BRANCH_B } });
  assert.equal((await run(auth, req)).nextCalled, true);
  assert.equal(req.kioskStaff.branchScope, null);
});

test('legacy mode does not load or check bearer callers (unchanged behaviour)', async () => {
  const staffLoads = [];
  const auth = makeAuth({ staffLoads })({ allowBearer: true });
  assert.equal((await run(auth, makeReq({ bearer: 'marketplace' }))).nextCalled, true);
  assert.equal((await run(auth, makeReq({ bearer: 'branchAdmin', params: { branch_id: BRANCH_B } }))).nextCalled, true);
  assert.deepEqual(staffLoads, []);
});

test('a staff lookup failure in enforce mode answers 500', async () => {
  const auth = createKioskAuth({
    verifyBearer: () => ({ sub: ADMIN_ID, role: 'admin' }),
    loadStaff: async () => { throw new Error('db down'); },
    env: { KIOSK_AUTH_ENFORCE: 'true' },
    warn: () => {},
    logError: () => {},
  })({ allowBearer: true });
  const { res, nextCalled } = await run(auth, makeReq({ bearer: 'jwt' }));
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 500);
});
