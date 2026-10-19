const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'certificate-module-test-secret';

const certificate = require('../src/models/certificate');
const kiosk = require('../src/models/kiosk');
const kioskRouter = require('../src/routers/kiosk');
const { db } = require('../src/config/postgres');
const {
  getCertificateStatus,
  isCertificateLifecycleError,
} = require('../src/services/certificateLifecycle');

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
  const lifecycleMigration = fs.readFileSync(
    path.resolve(__dirname, '..', 'db', 'postgres', 'certificate_lifecycle.sql'),
    'utf8',
  );
  const appSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'app.js'), 'utf8');
  const schemaRunner = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'apply-schema.sh'), 'utf8');

  assert.match(kiosk, /String\(code \|\| ''\)\.trim\(\)\.toUpperCase\(\)/);
  assert.match(kiosk, /idempotency_key is required for certificate bookings/);
  assert.match(kiosk, /serviceIds\.some\(\(id\) => !allowedSet\.has\(id\)\)/);
  assert.match(catalogService, /certificates: \[\]/);
  assert.match(catalogService, /serviceIds\.some\(\(serviceId\) => !allowed\.has/);
  assert.match(catalogMigration, /queue_entries_certificate_id_fkey/);
  assert.match(catalogMigration, /references certificates\(id\)/i);
  assert.match(appSource, /app\.use\('\/api\/kiosk', kiosk\)/);
  assert.match(appSource, /app\.use\('\/api\/marketplace', marketplace\)/);
  assert.match(schemaRunner, /certificate_lifecycle\.sql/);
  assert.match(kiosk, /reserved_queue_entry_id/);
  assert.doesNotMatch(kiosk, /\.update\(\{ is_used: true \}\)/);
  assert.match(lifecycleMigration, /reserved_queue_entry_id/);
  assert.match(lifecycleMigration, /new\.status = 'completed'/);
  assert.match(lifecycleMigration, /new\.status in \('waiting', 'called', 'swapped', 'in_progress'\)/);
  assert.match(lifecycleMigration, /new\.status in \('cancelled', 'rejected', 'no_show', 'not_in_time'\)/);
  assert.match(lifecycleMigration, /expires_at is null or expires_at > now\(\)/);
  assert.match(lifecycleMigration, /CERTIFICATE_UNAVAILABLE/);
  assert.match(lifecycleMigration, /CERTIFICATE_RESERVATION_MISSING/);
});

test('certificate lifecycle states distinguish active, reserved, used, and expired', () => {
  const now = new Date('2026-10-19T12:00:00.000Z');
  assert.equal(getCertificateStatus({ is_used: false }, now), 'active');
  assert.equal(getCertificateStatus({ is_used: false, reserved_queue_entry_id: 'queue-1' }, now), 'reserved');
  assert.equal(getCertificateStatus({ is_used: true, reserved_queue_entry_id: 'queue-1' }, now), 'used');
  assert.equal(getCertificateStatus({ is_used: false, expires_at: '2026-10-19T11:59:59.000Z' }, now), 'expired');
  assert.equal(isCertificateLifecycleError({ code: 'P0001', message: 'CERTIFICATE_UNAVAILABLE' }), true);
  assert.equal(isCertificateLifecycleError({ code: 'P0001', message: 'CERTIFICATE_RESERVATION_MISSING' }), true);
  assert.equal(isCertificateLifecycleError({ code: '23505', message: 'duplicate key' }), false);
});

function installCertificateLookup(response) {
  const originalFrom = db.from;
  const calls = [];
  const query = {
    select(value) {
      calls.push({ method: 'select', value });
      return this;
    },
    eq(column, value) {
      calls.push({ method: 'eq', column, value });
      return this;
    },
    maybeSingle() {
      return Promise.resolve(response);
    },
  };
  db.from = (table) => {
    calls.push({ method: 'from', table });
    return query;
  };
  return {
    calls,
    restore() {
      db.from = originalFrom;
    },
  };
}

test('GET /api/kiosk/certificate/:id resolves A005 case-insensitively and preserves auth gates', async () => {
  const routePaths = kioskRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path);
  assert.ok(routePaths.includes('/certificate/:id'));

  const token = jwt.sign({ sub: 'client-1', role: 'marketplace' }, process.env.JWT_SECRET);
  const mock = installCertificateLookup({
    data: {
      id: 'certificate-id',
      code: 'A005',
      expires_at: null,
      is_used: false,
      service_ids: ['service-1'],
      marketplace_barbershop_id: null,
    },
    error: null,
  });

  try {
    const authorizedResponse = response();
    await kiosk.certificate({
      headers: { authorization: `Bearer ${token}` },
      params: { id: 'a005' },
    }, authorizedResponse);

    assert.equal(authorizedResponse.statusCode, 200);
    assert.equal(authorizedResponse.body.certificate.code, 'A005');
    assert.deepEqual(
      mock.calls.find((call) => call.method === 'eq'),
      { method: 'eq', column: 'code', value: 'A005' },
    );

    const missingTokenResponse = response();
    await kiosk.certificate({ headers: {}, params: { id: 'A005' } }, missingTokenResponse);
    assert.equal(missingTokenResponse.statusCode, 401);
    assert.deepEqual(missingTokenResponse.body, { error: 'UNAUTHORIZED', code: 'UNAUTHORIZED' });

    const insufficientRoleToken = jwt.sign({ sub: 'client-1', role: 'client' }, process.env.JWT_SECRET);
    const forbiddenResponse = response();
    await kiosk.certificate({
      headers: { authorization: `Bearer ${insufficientRoleToken}` },
      params: { id: 'A005' },
    }, forbiddenResponse);
    assert.equal(forbiddenResponse.statusCode, 403);
    assert.deepEqual(forbiddenResponse.body, { error: 'FORBIDDEN', code: 'FORBIDDEN' });
  } finally {
    mock.restore();
  }
});

test('GET /api/kiosk/certificate/:id returns 404 for an unknown identifier', async () => {
  const token = jwt.sign({ sub: 'client-1', role: 'marketplace' }, process.env.JWT_SECRET);
  const mock = installCertificateLookup({ data: null, error: null });

  try {
    const res = response();
    await kiosk.certificate({
      headers: { authorization: `Bearer ${token}` },
      params: { id: 'UNKNOWN-CERTIFICATE' },
    }, res);

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Certificate not found' });
  } finally {
    mock.restore();
  }
});

test('GET /api/kiosk/certificate/:id rejects a certificate already reserved by a booking', async () => {
  const token = jwt.sign({ sub: 'client-1', role: 'marketplace' }, process.env.JWT_SECRET);
  const mock = installCertificateLookup({
    data: {
      id: 'certificate-id',
      code: 'A005',
      expires_at: null,
      is_used: false,
      reserved_queue_entry_id: 'queue-entry-1',
      service_ids: ['service-1'],
      marketplace_barbershop_id: null,
    },
    error: null,
  });

  try {
    const res = response();
    await kiosk.certificate({
      headers: { authorization: `Bearer ${token}` },
      params: { id: 'A005' },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { error: 'Certificate is reserved by another booking', code: 'CERTIFICATE_RESERVED' });
  } finally {
    mock.restore();
  }
});
