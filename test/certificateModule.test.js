const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'certificate-module-test-secret';

const certificate = require('../src/models/certificate');

const response = () => ({
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

test('certificate admin endpoints reject anonymous access before database work', async () => {
  const request = { headers: {}, body: {}, params: {} };
  for (const handler of [certificate.active, certificate.getById, certificate.create, certificate.update, certificate.remove]) {
    const res = response();
    await handler.call(certificate, request, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'UNAUTHORIZED', code: 'UNAUTHORIZED' });
  }
});

test('certificate contracts normalize bearer codes and do not expose codes in public payment options', () => {
  const kiosk = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'models', 'kiosk.js'), 'utf8');
  const catalogService = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'modules', 'marketplace', 'catalog', 'service.js'),
    'utf8',
  );
  const catalogMigration = fs.readFileSync(
    path.resolve(__dirname, '..', 'db', 'postgres', 'queue_entries.sql'),
    'utf8',
  );

  assert.match(kiosk, /String\(code \|\| ''\)\.trim\(\)\.toUpperCase\(\)/);
  assert.match(kiosk, /idempotency_key is required for certificate bookings/);
  assert.match(kiosk, /serviceIds\.some\(\(id\) => !allowedSet\.has\(id\)\)/);
  assert.match(catalogService, /certificates: \[\]/);
  assert.match(catalogService, /serviceIds\.some\(\(serviceId\) => !allowed\.has/);
  assert.match(catalogMigration, /queue_entries_certificate_id_fkey/);
  assert.match(catalogMigration, /references certificates\(id\)/i);
});
