const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');

const TEST_SECRET = 'test-secret';
process.env.JWT_SECRET = process.env.JWT_SECRET || TEST_SECRET;

const { rateLimit } = require('../src/middleware/rateLimit');

const makeResponse = () => ({
  statusCode: 200,
  headers: {},
  set(name, value) { this.headers[name] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test('rate limit follows authenticated client across changing IPs', () => {
  const middleware = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: `test-${Date.now()}` });
  const token = jwt.sign({ sub: 'marketplace-client-1' }, process.env.JWT_SECRET);
  let nextCalls = 0;

  const firstResponse = makeResponse();
  middleware({
    ip: '10.0.0.1',
    headers: { authorization: `Bearer ${token}` },
  }, firstResponse, () => { nextCalls += 1; });

  const secondResponse = makeResponse();
  middleware({
    ip: '10.0.0.2',
    headers: { authorization: `Bearer ${token}` },
  }, secondResponse, () => { nextCalls += 1; });

  assert.equal(nextCalls, 1);
  assert.equal(secondResponse.statusCode, 429);
  assert.equal(secondResponse.body.error, 'RATE_LIMITED');
});

test('forged tokens with fresh subjects do not get their own buckets', () => {
  const middleware = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: `forged-${Date.now()}` });
  let nextCalls = 0;
  let lastResponse;

  // Unsigned (alg "none") and wrong-secret tokens, each claiming a new subject.
  const forgedTokens = [
    jwt.sign({ sub: 'victim-1' }, null, { algorithm: 'none' }),
    jwt.sign({ sub: 'victim-2' }, 'attacker-secret'),
    jwt.sign({ sub: 'victim-3' }, null, { algorithm: 'none' }),
  ];

  for (const token of forgedTokens) {
    lastResponse = makeResponse();
    middleware({
      ip: '10.0.0.9',
      headers: { authorization: `Bearer ${token}` },
    }, lastResponse, () => { nextCalls += 1; });
  }

  assert.equal(nextCalls, 1, 'all forged requests must share the IP bucket');
  assert.equal(lastResponse.statusCode, 429);
});

test('keyBy ip ignores even a valid token subject', () => {
  const middleware = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: `ip-${Date.now()}`, keyBy: 'ip' });
  let nextCalls = 0;
  let lastResponse;

  for (const sub of ['user-a', 'user-b']) {
    lastResponse = makeResponse();
    middleware({
      ip: '10.0.0.10',
      headers: { authorization: `Bearer ${jwt.sign({ sub }, process.env.JWT_SECRET)}` },
    }, lastResponse, () => { nextCalls += 1; });
  }

  assert.equal(nextCalls, 1);
  assert.equal(lastResponse.statusCode, 429);
});

test('POST /api/auth/login returns 429 after the per-IP limit', async () => {
  const barbersPath = require.resolve('../src/models/barbers');
  const authRouterPath = require.resolve('../src/routers/auth');
  const telegramRouterPath = require.resolve('../src/routers/telegramAuth');
  const originals = {
    barbers: require.cache[barbersPath],
    auth: require.cache[authRouterPath],
    telegram: require.cache[telegramRouterPath],
  };

  // Stub the DB-backed login handler and the telegram sub-router so the
  // router can be mounted without a database.
  require.cache[barbersPath] = {
    id: barbersPath, filename: barbersPath, loaded: true,
    exports: { login: (req, res) => res.status(401).json({ error: 'INVALID_CREDENTIALS' }) },
  };
  require.cache[telegramRouterPath] = {
    id: telegramRouterPath, filename: telegramRouterPath, loaded: true,
    exports: express.Router(),
  };
  delete require.cache[authRouterPath];

  const { STAFF_LOGIN_RATE_LIMIT } = require('../src/routers/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routers/auth'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const attempt = () => fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'admin', password: 'wrong' }),
    });

    for (let i = 0; i < STAFF_LOGIN_RATE_LIMIT.max; i += 1) {
      const response = await attempt();
      assert.equal(response.status, 401, `attempt ${i + 1} should reach the handler`);
    }

    const limited = await attempt();
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'RATE_LIMITED' });
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    for (const [key, filePath] of [['barbers', barbersPath], ['auth', authRouterPath], ['telegram', telegramRouterPath]]) {
      if (originals[key]) require.cache[filePath] = originals[key];
      else delete require.cache[filePath];
    }
  }
});
