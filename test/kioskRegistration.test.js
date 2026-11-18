const test = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();

const { createKioskRegistry, hashDeviceToken } = require('../src/services/kioskRegistration');

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';
const DEVICE = 'Xiaomi 2505DRP06G [a3c21247e1f09762]';
const KIOSK_ID = '33333333-3333-4333-8333-333333333333';

function makeRepo({ branches = [BRANCH_A, BRANCH_B], kiosks = [] } = {}) {
  const rows = kiosks.map((row) => ({ ...row }));
  return {
    rows,
    async branchExists(branchId) {
      return branches.includes(branchId);
    },
    // Mirrors the SQL upsert: a row that already holds a token is never overwritten.
    async saveKiosk({ branchId, deviceName, tokenHash }) {
      const existing = rows.find((row) => row.branch_id === branchId && row.device_name === deviceName);
      if (existing) {
        if (existing.device_token_hash) return null;
        existing.device_token_hash = tokenHash;
        return existing;
      }
      const row = { id: `k${rows.length + 1}`, branch_id: branchId, device_name: deviceName, device_token_hash: tokenHash };
      rows.push(row);
      return row;
    },
    async findKiosk({ branchId, deviceName }) {
      return rows.find((row) => row.branch_id === branchId && row.device_name === deviceName) || null;
    },
    async findKioskById(id) {
      return rows.find((row) => row.id === id) || null;
    },
    async listKiosks({ branchId }) {
      return rows.filter((row) => !branchId || row.branch_id === branchId);
    },
    async deleteKiosk(id) {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows.splice(index, 1);
    },
  };
}

const NETWORK_ADMIN = { role: 'admin', branch_id: null };
const MANAGER_A = { role: 'manager', branch_id: BRANCH_A };

test('register validates branch id and device name', async () => {
  const registry = createKioskRegistry({ repo: makeRepo() });
  assert.equal((await registry.register({ branchId: 'nope', deviceName: DEVICE })).status, 400);
  assert.equal((await registry.register({ branchId: BRANCH_A, deviceName: '   ' })).status, 400);
  assert.equal((await registry.register({ branchId: BRANCH_A, deviceName: 'x'.repeat(201) })).status, 400);
});

test('register answers 404 for an unknown branch', async () => {
  const registry = createKioskRegistry({ repo: makeRepo({ branches: [BRANCH_A] }) });
  const result = await registry.register({ branchId: BRANCH_B, deviceName: DEVICE });
  assert.equal(result.status, 404);
});

test('register needs no staff and returns a device token, storing only its hash', async () => {
  const repo = makeRepo();
  const registry = createKioskRegistry({ repo });
  const result = await registry.register({ branchId: BRANCH_A, deviceName: ` ${DEVICE} ` });

  assert.equal(result.status, 201);
  assert.equal(result.body.branch_id, BRANCH_A);
  assert.ok(result.body.kiosk_id);
  assert.match(result.body.device_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(repo.rows[0].device_name, DEVICE);
  assert.equal(repo.rows[0].device_token_hash, hashDeviceToken(result.body.device_token));
  assert.notEqual(repo.rows[0].device_token_hash, result.body.device_token);
});

test('an already registered kiosk cannot be taken over by registering its name again', async () => {
  const repo = makeRepo();
  const registry = createKioskRegistry({ repo });
  const first = await registry.register({ branchId: BRANCH_A, deviceName: DEVICE });
  const second = await registry.register({ branchId: BRANCH_A, deviceName: DEVICE });

  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'KIOSK_ALREADY_REGISTERED');
  const ticket = await registry.authorizeTicket({ branchId: BRANCH_A, deviceName: DEVICE, deviceToken: first.body.device_token });
  assert.equal(ticket.status, 200);
});

test('a legacy kiosk without a token can register to get one', async () => {
  const repo = makeRepo({ kiosks: [{ id: 'k0', branch_id: BRANCH_A, device_name: DEVICE, device_token_hash: null }] });
  const registry = createKioskRegistry({ repo });
  const result = await registry.register({ branchId: BRANCH_A, deviceName: DEVICE });
  assert.equal(result.status, 201);
  assert.equal(repo.rows.length, 1);
  assert.equal(repo.rows[0].device_token_hash, hashDeviceToken(result.body.device_token));
});

test('registering never removes kiosks of another branch', async () => {
  const repo = makeRepo({ kiosks: [{ id: 'k0', branch_id: BRANCH_B, device_name: DEVICE, device_token_hash: 'h' }] });
  const registry = createKioskRegistry({ repo });
  assert.equal((await registry.register({ branchId: BRANCH_A, deviceName: DEVICE })).status, 201);
  assert.deepEqual(repo.rows.map((row) => row.branch_id).sort(), [BRANCH_A, BRANCH_B].sort());
});

test('registering a second kiosk keeps the branch first kiosk', async () => {
  const repo = makeRepo({ kiosks: [{ id: 'k0', branch_id: BRANCH_A, device_name: 'samsung [1]', device_token_hash: null }] });
  const registry = createKioskRegistry({ repo });
  await registry.register({ branchId: BRANCH_A, deviceName: DEVICE });
  assert.deepEqual(repo.rows.map((row) => row.device_name).sort(), [DEVICE, 'samsung [1]'].sort());
});

test('after an admin deletes a kiosk the device can register again', async () => {
  const repo = makeRepo({ kiosks: [{ id: KIOSK_ID, branch_id: BRANCH_A, device_name: DEVICE, device_token_hash: 'h' }] });
  const registry = createKioskRegistry({ repo });
  assert.equal((await registry.register({ branchId: BRANCH_A, deviceName: DEVICE })).status, 409);
  assert.equal((await registry.removeKiosk({ id: KIOSK_ID, actor: MANAGER_A })).status, 204);
  assert.equal((await registry.register({ branchId: BRANCH_A, deviceName: DEVICE })).status, 201);
});

test('socket ticket requires the device token once the kiosk has one', async () => {
  const repo = makeRepo();
  const registry = createKioskRegistry({ repo });
  const { body } = await registry.register({ branchId: BRANCH_A, deviceName: DEVICE });

  assert.equal((await registry.authorizeTicket({ branchId: BRANCH_A, deviceName: DEVICE })).status, 403);
  assert.equal((await registry.authorizeTicket({ branchId: BRANCH_A, deviceName: DEVICE, deviceToken: 'wrong' })).status, 403);
  const ok = await registry.authorizeTicket({ branchId: BRANCH_A, deviceName: DEVICE, deviceToken: body.device_token });
  assert.equal(ok.status, 200);
  assert.equal(ok.kiosk.branch_id, BRANCH_A);
});

test('kiosks registered before device tokens keep working without one', async () => {
  const repo = makeRepo({ kiosks: [{ id: 'k0', branch_id: BRANCH_A, device_name: DEVICE, device_token_hash: null }] });
  const registry = createKioskRegistry({ repo });
  assert.equal((await registry.authorizeTicket({ branchId: BRANCH_A, deviceName: DEVICE })).status, 200);
});

test('socket ticket answers 403 for an unregistered device and 400 for missing fields', async () => {
  const registry = createKioskRegistry({ repo: makeRepo() });
  assert.equal((await registry.authorizeTicket({ branchId: BRANCH_A, deviceName: DEVICE })).status, 403);
  assert.equal((await registry.authorizeTicket({ branchId: BRANCH_A })).status, 400);
  assert.equal((await registry.authorizeTicket({ branchId: 'not-a-uuid', deviceName: DEVICE })).status, 400);
});

test('listKiosks limits branch roles to their own branch and hides token hashes', async () => {
  const repo = makeRepo({
    kiosks: [
      { id: 'k1', branch_id: BRANCH_A, device_name: 'A', device_token_hash: 'h1' },
      { id: 'k2', branch_id: BRANCH_B, device_name: 'B', device_token_hash: null },
    ],
  });
  const registry = createKioskRegistry({ repo });

  const own = await registry.listKiosks({ actor: MANAGER_A });
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.entry.map((row) => row.id), ['k1']);
  assert.equal(own.body.entry[0].device_token_hash, undefined);
  assert.equal(own.body.entry[0].has_device_token, true);

  const all = await registry.listKiosks({ actor: NETWORK_ADMIN });
  assert.deepEqual(all.body.entry.map((row) => row.id).sort(), ['k1', 'k2']);

  const filtered = await registry.listKiosks({ actor: NETWORK_ADMIN, branchId: BRANCH_B });
  assert.deepEqual(filtered.body.entry.map((row) => row.id), ['k2']);
  assert.equal((await registry.listKiosks({ actor: MANAGER_A, branchId: BRANCH_B })).status, 403);
});

test('removeKiosk validates the id and enforces branch scope', async () => {
  const repo = makeRepo({ kiosks: [{ id: KIOSK_ID, branch_id: BRANCH_B, device_name: DEVICE, device_token_hash: 'h' }] });
  const registry = createKioskRegistry({ repo });

  assert.equal((await registry.removeKiosk({ id: 'bad', actor: NETWORK_ADMIN })).status, 400);
  assert.equal((await registry.removeKiosk({ id: '44444444-4444-4444-8444-444444444444', actor: NETWORK_ADMIN })).status, 404);
  assert.equal((await registry.removeKiosk({ id: KIOSK_ID, actor: MANAGER_A })).status, 403);
  assert.equal(repo.rows.length, 1);
  assert.equal((await registry.removeKiosk({ id: KIOSK_ID, actor: NETWORK_ADMIN })).status, 204);
  assert.equal(repo.rows.length, 0);
});
