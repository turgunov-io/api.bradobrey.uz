// Kiosk socket tickets and company status (security review L3): a suspended
// company's kiosks get no new ticket, and a ticket issued before suspension
// stops working on the next socket connect.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PGDATABASE ||= 'kiosk-socket-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'kiosk-socket-tests';

const { createKioskRegistry } = require('../src/services/kioskRegistration');

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';
const KIOSK_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE = 'Lenovo Tab [01]';

function registry(companyStatus) {
  const kiosk = { id: KIOSK_ID, branch_id: BRANCH_A, device_name: DEVICE, device_token_hash: null, company_status: companyStatus };
  return createKioskRegistry({
    repo: {
      async findKiosk({ branchId, deviceName }) { return branchId === BRANCH_A && deviceName === DEVICE ? kiosk : null; },
      async findKioskById(id) { return id === KIOSK_ID ? kiosk : null; },
    },
  });
}

test('socket ticket is refused for a kiosk of a suspended company', async () => {
  const suspended = await registry('suspended').authorizeTicket({ branchId: BRANCH_A, deviceName: DEVICE });
  assert.equal(suspended.status, 403);
  assert.equal(suspended.body.code, 'COMPANY_SUSPENDED');
  assert.equal((await registry('active').authorizeTicket({ branchId: BRANCH_A, deviceName: DEVICE })).status, 200);
});

test('socket connect re-checks the kiosk, its branch and its company status', async () => {
  assert.equal(await registry('active').verifySocketKiosk({ kioskId: KIOSK_ID, branchId: BRANCH_A }), true);
  assert.equal(await registry('suspended').verifySocketKiosk({ kioskId: KIOSK_ID, branchId: BRANCH_A }), false);
  assert.equal(await registry(null).verifySocketKiosk({ kioskId: KIOSK_ID, branchId: BRANCH_A }), false);
  assert.equal(await registry('active').verifySocketKiosk({ kioskId: KIOSK_ID, branchId: BRANCH_B }), false, 'other branch');
  assert.equal(await registry('active').verifySocketKiosk({ kioskId: '44444444-4444-4444-8444-444444444444', branchId: BRANCH_A }), false, 'deleted kiosk');
  assert.equal(await registry('active').verifySocketKiosk({ kioskId: 'nope', branchId: BRANCH_A }), false);
});
