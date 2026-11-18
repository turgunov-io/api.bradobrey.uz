const test = require('node:test');
const assert = require('node:assert/strict');

// The registry module loads (but never queries) the pg pool.
process.env.PGDATABASE ||= 'kiosk-enrollment-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'kiosk-enrollment-tests';

const { createKioskRegistry, hashDeviceToken } = require('../src/services/kioskRegistration');

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';
const DEVICE = 'Xiaomi 2505DRP06G [a3c21247e1f09762]';

function makeRepo(kiosks = []) {
  const rows = kiosks.map((row) => ({ ...row }));
  return {
    rows,
    async branchExists() { return true; },
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
    async findKioskByTokenHash(hash) {
      return rows.find((row) => row.device_token_hash === hash) || null;
    },
  };
}

// DB rows by user id: the staff actor is always loaded from here (role and
// branch scope from the DB, never from the JWT claims).
const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MANAGER_A_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MANAGER_B_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BARBER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ARCHIVED_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const MULTI_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const DB_ACTORS = {
  [ADMIN_ID]: { id: ADMIN_ID, role: 'admin', branchScope: null },
  [MANAGER_A_ID]: { id: MANAGER_A_ID, role: 'manager', branchScope: [BRANCH_A] },
  [MANAGER_B_ID]: { id: MANAGER_B_ID, role: 'manager', branchScope: [BRANCH_B] },
  [BARBER_ID]: { id: BARBER_ID, role: 'barber', branchScope: [BRANCH_A] },
  [MULTI_ID]: { id: MULTI_ID, role: 'admin_branch', branchScope: [BRANCH_B, BRANCH_A] },
};

const registryWithCode = (code, repo = makeRepo(), loads = []) => createKioskRegistry({
  repo,
  enrollmentCode: () => code,
  loadActor: async (claims) => { loads.push(claims); return DB_ACTORS[claims?.sub] || null; },
  warn: () => {},
});

test('register requires a matching enrollment_code when KIOSK_ENROLLMENT_CODE is set', async () => {
  const registry = registryWithCode('s3cret-code');
  const missing = await registry.register({ branchId: BRANCH_A, deviceName: DEVICE });
  const wrong = await registry.register({ branchId: BRANCH_A, deviceName: DEVICE, enrollmentCode: 's3cret-cod' });
  const right = await registry.register({ branchId: BRANCH_A, deviceName: DEVICE, enrollmentCode: 's3cret-code' });

  assert.equal(missing.status, 403);
  assert.equal(missing.body.code, 'KIOSK_ENROLLMENT_CODE_INVALID');
  assert.equal(wrong.status, 403);
  assert.equal(right.status, 201);
});

test('register keeps the open behaviour (with a warning) when no enrollment code is configured', async () => {
  const warnings = [];
  const registry = createKioskRegistry({ repo: makeRepo(), enrollmentCode: () => '', warn: (msg) => warnings.push(msg) });
  assert.equal((await registry.register({ branchId: BRANCH_A, deviceName: DEVICE })).status, 201);
  assert.equal((await registry.register({ branchId: BRANCH_A, deviceName: 'other' })).status, 201);
  assert.equal(warnings.length, 1);
});

test('staff in scope may register a kiosk without the enrollment code', async () => {
  const registry = registryWithCode('s3cret-code');
  const admin = await registry.register({ branchId: BRANCH_A, deviceName: DEVICE, actorClaims: { sub: ADMIN_ID, role: 'admin' } });
  const manager = await registry.register({ branchId: BRANCH_A, deviceName: 'm', actorClaims: { sub: MANAGER_A_ID, role: 'manager' } });
  const foreignManager = await registry.register({ branchId: BRANCH_A, deviceName: 'f', actorClaims: { sub: MANAGER_B_ID, role: 'manager' } });
  const multi = await registry.register({ branchId: BRANCH_A, deviceName: 'mb', actorClaims: { sub: MULTI_ID, role: 'admin_branch' } });
  const marketplace = await registry.register({ branchId: BRANCH_A, deviceName: 'x', actorClaims: { sub: 'c1', role: 'marketplace' } });

  assert.equal(admin.status, 201);
  assert.equal(manager.status, 201);
  assert.equal(foreignManager.status, 403);
  assert.equal(multi.status, 201);
  assert.equal(marketplace.status, 403);
});

test('register ignores the JWT role/branch claims and uses the DB-loaded actor', async () => {
  const registry = registryWithCode('s3cret-code');
  // Token claims network admin, DB says barber -> no bypass.
  const forgedRole = await registry.register({ branchId: BRANCH_A, deviceName: 'r', actorClaims: { sub: BARBER_ID, role: 'admin' } });
  // Token claims branch A, DB scope is branch B -> no bypass.
  const forgedBranch = await registry.register({
    branchId: BRANCH_A, deviceName: 'b', actorClaims: { sub: MANAGER_B_ID, role: 'manager', branch_id: BRANCH_A, branchId: BRANCH_A },
  });
  // Archived / deleted employee: the loader returns no actor.
  const archived = await registry.register({ branchId: BRANCH_A, deviceName: 'a', actorClaims: { sub: ARCHIVED_ID, role: 'admin' } });

  assert.equal(forgedRole.status, 403);
  assert.equal(forgedBranch.status, 403);
  assert.equal(archived.status, 403);
});

test('register does not load the actor when the enrollment code already matches', async () => {
  const loads = [];
  const registry = registryWithCode('s3cret-code', makeRepo(), loads);
  const result = await registry.register({ branchId: BRANCH_A, deviceName: DEVICE, enrollmentCode: 's3cret-code', actorClaims: { sub: ADMIN_ID } });
  assert.equal(result.status, 201);
  assert.deepEqual(loads, []);
});

test('a legacy kiosk re-registers to get a token when it sends the enrollment code', async () => {
  const repo = makeRepo([{ id: 'k0', branch_id: BRANCH_A, device_name: DEVICE, device_token_hash: null }]);
  const registry = registryWithCode('s3cret-code', repo);
  const result = await registry.register({ branchId: BRANCH_A, deviceName: DEVICE, enrollmentCode: 's3cret-code' });
  assert.equal(result.status, 201);
  assert.equal(repo.rows.length, 1);
});

test('authenticateDevice resolves a device token to the kiosk id and branch', async () => {
  const repo = makeRepo([{ id: 'k9', branch_id: BRANCH_B, device_name: DEVICE, device_token_hash: hashDeviceToken('tok') }]);
  const registry = registryWithCode('', repo);

  assert.deepEqual(await registry.authenticateDevice('tok'), { id: 'k9', branchId: BRANCH_B });
  assert.equal(await registry.authenticateDevice('nope'), null);
  assert.equal(await registry.authenticateDevice(''), null);
  assert.equal(await registry.authenticateDevice('x'.repeat(1000)), null);
});
