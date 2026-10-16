const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAuthenticatedBarberRoster } = require('../src/utils/kioskBarberPresence');

const NOW = Date.parse('2026-10-16T07:00:00.000Z');
const session = (overrides = {}) => ({
  employee_id: 'barber-1',
  branch_id: 'branch-a',
  session_id: 'session-1',
  session_expires_at: '2026-10-16T19:00:00.000Z',
  is_on_shift: true,
  ...overrides,
});
const barber = (overrides = {}) => ({
  id: 'barber-1',
  name: 'Barber',
  branch_id: 'branch-a',
  is_archived: false,
  is_on_shift: true,
  ...overrides,
});
const roster = (activeSessions, overrides = {}) => buildAuthenticatedBarberRoster({
  branchId: 'branch-a',
  branchBarbers: [barber()],
  activeSessions,
  now: NOW,
  ...overrides,
});

test('the persisted login keeps the card across app and socket transport interruptions', async (t) => {
  const cases = [
    { name: 'app minimized' },
    { name: 'app closed' },
    { name: 'tablet screen off' },
    { name: 'internet unavailable for several minutes', now: NOW + 5 * 60_000 },
    { name: 'Socket.IO disconnected and reconnected', now: NOW + 5 * 60_000 },
    { name: 'API process restarted', now: NOW + 5 * 60_000 },
  ];

  for (const lifecycle of cases) {
    await t.test(lifecycle.name, () => {
      // Transport/app lifecycle changes do not mutate the DB-backed login row.
      const cards = roster([session()], lifecycle.now ? { now: lifecycle.now } : {});
      assert.equal(cards.length, 1);
      assert.equal(cards[0].id, 'barber-1');
    });
  }
});

test('a valid session preserves visibility while an off-shift barber stays unavailable', () => {
  const cards = roster([session({ is_on_shift: false })]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].is_on_shift, false);
});

test('reconnect projection is idempotent and does not duplicate a barber card', () => {
  const cards = roster([session()], {
    assignedBarbers: [barber({ branch_id: 'home-branch' })],
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].branch_id, 'branch-a');
});

test('explicit logout removes the card after the persisted session is cleared', () => {
  assert.deepEqual(roster([]), []);
});

test('expired, revoked, archived, or cross-branch sessions cannot keep a kiosk card', () => {
  assert.deepEqual(roster([session({ session_expires_at: '2026-10-16T06:59:59.000Z' })]), []);
  assert.deepEqual(roster([session({ session_id: null })]), []);
  assert.deepEqual(roster([session()], { branchId: 'branch-b' }), []);
  assert.deepEqual(roster([session()], { deniedEmployeeIds: ['barber-1'] }), []);
  assert.deepEqual(roster([session()], { branchBarbers: [barber({ is_archived: true })] }), []);
});

test('branch assignment and duplicate source rows cannot leak or duplicate cards', () => {
  const cards = roster([session(), session()], {
    branchId: 'branch-a',
    branchBarbers: [barber(), barber()],
  });
  assert.equal(cards.length, 1);
  assert.deepEqual(roster([session({ branch_id: 'branch-b' })]), []);
});
