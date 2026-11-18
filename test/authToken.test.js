// Unified JWT helper (MULTI_TENANCY Phase 1 step B1): one place for the
// secret, the pinned algorithm and the token-kind checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const {
  JWT_ALGORITHMS,
  MARKETPLACE_ROLE,
  getBearerToken,
  verifyAny,
  verifyMarketplaceToken,
  verifyStaffToken,
} = require('../src/utils/authToken');

const SECRET = 'auth-token-test-secret';
const USER_ID = '11111111-1111-4111-8111-111111111111';

test('verifyAny accepts an HS256 token signed with the configured secret', () => {
  const token = jwt.sign({ sub: USER_ID, role: 'admin' }, SECRET);
  const payload = verifyAny(token, { secret: SECRET });
  assert.equal(payload.sub, USER_ID);
  assert.deepEqual(JWT_ALGORITHMS, ['HS256']);
});

test('verifyAny reads JWT_SECRET from the environment by default', () => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  try {
    const token = jwt.sign({ sub: USER_ID, role: 'admin' }, SECRET);
    assert.equal(verifyAny(token).sub, USER_ID);
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});

test('verifyAny rejects tokens signed with another HMAC algorithm (algorithm pinned to HS256)', () => {
  const token = jwt.sign({ sub: USER_ID, role: 'admin' }, SECRET, { algorithm: 'HS512' });
  assert.throws(() => verifyAny(token, { secret: SECRET }), /invalid algorithm/);
});

test('verifyAny rejects unsigned (alg=none) tokens', () => {
  const token = jwt.sign({ sub: USER_ID, role: 'admin' }, null, { algorithm: 'none' });
  assert.throws(() => verifyAny(token, { secret: SECRET }));
});

test('verifyAny throws when no secret is configured', () => {
  const previous = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    const token = jwt.sign({ sub: USER_ID }, SECRET);
    assert.throws(() => verifyAny(token), /JWT_SECRET is not configured/);
  } finally {
    if (previous !== undefined) process.env.JWT_SECRET = previous;
  }
});

test('verifyAny rejects expired and tampered tokens', () => {
  const expired = jwt.sign({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
  assert.throws(() => verifyAny(expired, { secret: SECRET }), /expired/);
  const forged = jwt.sign({ sub: USER_ID }, 'other-secret');
  assert.throws(() => verifyAny(forged, { secret: SECRET }), /invalid signature/);
});

test('verifyStaffToken rejects marketplace client tokens', () => {
  const staff = jwt.sign({ sub: USER_ID, role: 'barber' }, SECRET);
  assert.equal(verifyStaffToken(staff, { secret: SECRET }).role, 'barber');
  const client = jwt.sign({ sub: USER_ID, role: MARKETPLACE_ROLE }, SECRET);
  assert.throws(() => verifyStaffToken(client, { secret: SECRET }), (error) => error.code === 'TOKEN_KIND_MISMATCH');
});

test('verifyMarketplaceToken accepts only marketplace client tokens', () => {
  const client = jwt.sign({ sub: USER_ID, role: MARKETPLACE_ROLE }, SECRET);
  assert.equal(verifyMarketplaceToken(client, { secret: SECRET }).role, MARKETPLACE_ROLE);
  const staff = jwt.sign({ sub: USER_ID, role: 'admin' }, SECRET);
  assert.throws(() => verifyMarketplaceToken(staff, { secret: SECRET }), (error) => error.code === 'TOKEN_KIND_MISMATCH');
});

test('getBearerToken extracts only Bearer authorization headers', () => {
  assert.equal(getBearerToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(getBearerToken({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(getBearerToken({ headers: {} }), null);
  assert.equal(getBearerToken({}), null);
});

test('no module outside utils/authToken.js calls jwt.verify directly', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|ts)$/.test(entry.name) && !full.endsWith(path.join('utils', 'authToken.js'))) {
        if (/\bjwt\.verify\(/.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
      }
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  assert.deepEqual(offenders, []);
});
