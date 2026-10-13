const { issueKioskSocketTicket, verifyKioskSocketTicket } = require('../src/kioskSocketTicket');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const secret = 'test-kiosk-socket-secret-that-is-long-enough';
const now = Date.parse('2026-10-14T00:00:00.000Z');

test('binds a short-lived ticket to the kiosk and branch', () => {
  const ticket = issueKioskSocketTicket({
    kioskId: 'kiosk-1', branchId: 'branch-1', deviceName: 'front-desk',
    now, ttlSeconds: 900, secret,
  });
  assert.deepEqual(verifyKioskSocketTicket(ticket, secret, now), {
    kind: 'kiosk', kioskId: 'kiosk-1', branchId: 'branch-1', deviceName: 'front-desk',
    iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 900,
  });
});

test('rejects tampered and expired tickets', () => {
  const ticket = issueKioskSocketTicket({
    kioskId: 'kiosk-1', branchId: 'branch-1', deviceName: 'front-desk',
    now, ttlSeconds: 60, secret,
  });
  assert.throws(() => verifyKioskSocketTicket(`${ticket}x`, secret, now));
  assert.throws(() => verifyKioskSocketTicket(ticket, secret, now + 61_000), /Expired/);
});
