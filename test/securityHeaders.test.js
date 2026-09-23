const test = require('node:test');
const assert = require('node:assert/strict');

const { securityHeaders } = require('../src/middleware/securityHeaders');

function response() {
  return {
    headers: {},
    set(name, value) { this.headers[name] = value; },
  };
}

test('security headers set a safe request id and baseline policies', () => {
  const req = { headers: { 'x-request-id': 'client-42' } };
  const res = response();
  let called = false;
  securityHeaders(req, res, () => { called = true; });

  assert.equal(called, true);
  assert.equal(req.requestId, 'client-42');
  assert.equal(res.headers['X-Request-Id'], 'client-42');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('invalid request id is replaced instead of reflected', () => {
  const req = { headers: { 'x-request-id': '<script>alert(1)</script>' } };
  const res = response();
  securityHeaders(req, res, () => {});

  assert.notEqual(req.requestId, req.headers['x-request-id']);
  assert.match(req.requestId, /^[A-Za-z0-9._:-]{1,100}$/);
});
