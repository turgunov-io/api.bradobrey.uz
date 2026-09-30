const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { requireAdmin } = require('../src/utils/adminAuth');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('admin loyalty endpoints require an authenticated administrator role', () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'loyalty-test-secret';
  try {
    const noToken = responseRecorder();
    assert.equal(requireAdmin({ headers: {} }, noToken), null);
    assert.equal(noToken.statusCode, 401);

    const invalid = responseRecorder();
    assert.equal(requireAdmin({ headers: { authorization: 'Bearer invalid' } }, invalid), null);
    assert.equal(invalid.statusCode, 401);

    const clientToken = jwt.sign({ role: 'marketplace', sub: 'client' }, process.env.JWT_SECRET);
    const client = responseRecorder();
    assert.equal(requireAdmin({ headers: { authorization: `Bearer ${clientToken}` } }, client), null);
    assert.equal(client.statusCode, 403);

    const adminToken = jwt.sign({ role: 'admin_network', sub: 'admin-1' }, process.env.JWT_SECRET);
    const admin = responseRecorder();
    assert.equal(requireAdmin({ headers: { authorization: `Bearer ${adminToken}` } }, admin).sub, 'admin-1');
    assert.equal(admin.statusCode, 200);
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});
