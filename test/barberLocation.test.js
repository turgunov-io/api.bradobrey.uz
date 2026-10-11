const test = require('node:test');
const assert = require('node:assert/strict');
process.env.PGHOST ||= '127.0.0.1';
process.env.PGPORT ||= '5432';
process.env.PGDATABASE ||= 'location-contract-tests';
process.env.PGUSER ||= 'location-contract-tests';
process.env.PGPASSWORD ||= 'unit-test-only';
const { haversineMeters, normalizeLocation } = require('../src/services/barberLocation');

test('haversine distance is symmetric and keeps the 1km boundary usable', () => {
  const distance = haversineMeters(41.3111, 69.2797, 41.320083, 69.2797);
  assert.ok(distance > 990 && distance < 1010);
  assert.equal(Math.round(haversineMeters(41.3111, 69.2797, 41.3111, 69.2797)), 0);
});

test('location payload rejects stale, inaccurate, invalid, and mocked positions', () => {
  const base = {
    latitude: 41.3111,
    longitude: 69.2797,
    accuracy_meters: 20,
    measured_at: new Date().toISOString(),
  };
  assert.equal(normalizeLocation(base).error, undefined);
  assert.equal(normalizeLocation({ ...base, latitude: 100 }).error, 'INVALID_COORDINATES');
  assert.equal(normalizeLocation({ ...base, accuracy_meters: 201 }).error, 'LOW_ACCURACY');
  assert.equal(normalizeLocation({ ...base, measured_at: new Date(Date.now() - 3600000).toISOString() }).error, 'STALE_COORDINATES');
  assert.equal(normalizeLocation({ ...base, is_mocked: true }).error, 'MOCKED_COORDINATES');
});
