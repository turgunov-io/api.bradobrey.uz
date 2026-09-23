const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

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
  const token = jwt.sign({ sub: 'marketplace-client-1' }, 'test-secret');
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
