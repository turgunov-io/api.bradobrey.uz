const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

require('dotenv').config();

const SECRET = 'employee-management-test-secret-0123456789abcdef';
process.env.JWT_SECRET = process.env.JWT_SECRET || SECRET;

const { createEmployeeManagementGuard } = require('../src/middleware/employeeManagement');

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';

const ACTORS = {
  network: { user: { id: 'u-network', role: 'admin_network', branch_id: null }, permissions: [] },
  admin: { user: { id: 'u-admin', role: 'admin', branch_id: BRANCH_A }, permissions: [] },
  superManager: {
    user: { id: 'u-super', role: 'super-manager', branch_id: BRANCH_A },
    permissions: ['dashboard.access', 'employees.read', 'employees.create', 'employees.update'],
  },
  manager: {
    user: { id: 'u-manager', role: 'manager', branch_id: BRANCH_A },
    permissions: ['dashboard.access', 'employees.read', 'employees.update'],
  },
  managerNoPerms: { user: { id: 'u-manager2', role: 'manager', branch_id: BRANCH_A }, permissions: [] },
  barber: { user: { id: 'u-barber', role: 'barber', branch_id: BRANCH_A }, permissions: ['queue.read'] },
};

const TARGETS = {
  [TARGET_ID]: { id: TARGET_ID, role: 'barber', branch_id: BRANCH_A },
  'target-other-branch': { id: 'target-other-branch', role: 'barber', branch_id: BRANCH_B },
  'target-network': { id: 'target-network', role: 'admin_network', branch_id: null },
  'target-super': { id: 'target-super', role: 'super-manager', branch_id: BRANCH_A },
};

function makeGuard() {
  return createEmployeeManagementGuard({
    secret: SECRET,
    loadActor: async (userId) => Object.values(ACTORS).find((actor) => actor.user.id === userId) || null,
    loadTarget: async (id) => TARGETS[id] || null,
    // Fixture ids are readable names, not UUIDs; UUID validation has its own test.
    validateId: false,
  });
}

const tokenFor = (actorKey) => jwt.sign(
  { sub: ACTORS[actorKey].user.id, role: ACTORS[actorKey].user.role },
  SECRET,
  { expiresIn: '1h' },
);

function fakeReq({ actor, token, params = {}, body = {}, query = {} } = {}) {
  const bearer = token ?? (actor ? tokenFor(actor) : null);
  return {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    params,
    body,
    query,
  };
}

async function run(middleware, req) {
  let statusCode = 200;
  let body;
  let nextCalled = false;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await middleware(req, res, () => { nextCalled = true; });
  return { status: nextCalled ? null : statusCode, body, nextCalled };
}

// Runs authorize(action) and, if it passes, checkPayload — the same order the router uses.
async function runChain(action, req) {
  const guard = makeGuard();
  const first = await run(guard.authorize(action), req);
  if (!first.nextCalled) return first;
  return run(guard.checkPayload, req);
}

test('rejects requests without a token with 401 for every action', async () => {
  for (const action of ['read', 'create', 'update', 'delete']) {
    const result = await runChain(action, fakeReq({ params: { id: TARGET_ID } }));
    assert.equal(result.status, 401, action);
  }
});

test('rejects invalid tokens with 401', async () => {
  const result = await runChain('create', fakeReq({ token: 'not-a-jwt' }));
  assert.equal(result.status, 401);
});

test('rejects tokens whose user no longer exists with 401', async () => {
  const token = jwt.sign({ sub: 'ghost', role: 'admin_network' }, SECRET);
  const result = await runChain('create', fakeReq({ token, body: { role: 'barber', branch_id: BRANCH_A } }));
  assert.equal(result.status, 401);
});

test('rejects operational barber roles with 403', async () => {
  const result = await runChain('read', fakeReq({ actor: 'barber' }));
  assert.equal(result.status, 403);
});

test('requires the matching employees.* permission', async () => {
  const create = await runChain('create', fakeReq({ actor: 'manager', body: { role: 'barber', branch_id: BRANCH_A } }));
  assert.equal(create.status, 403, 'manager without employees.create');

  const read = await runChain('read', fakeReq({ actor: 'managerNoPerms' }));
  assert.equal(read.status, 403, 'manager without employees.read');
});

test('admin_network superuser can create any employee role in any branch', async () => {
  for (const role of ['admin', 'super-manager', 'manager', 'barber']) {
    const result = await runChain('create', fakeReq({ actor: 'network', body: { role, branch_id: BRANCH_B } }));
    assert.equal(result.nextCalled, true, role);
  }
});

test('non-superusers cannot assign a role at or above their own', async () => {
  const toAdmin = await runChain('create', fakeReq({ actor: 'superManager', body: { role: 'admin', branch_id: BRANCH_A } }));
  assert.equal(toAdmin.status, 403);

  const toPeer = await runChain('create', fakeReq({ actor: 'superManager', body: { role: 'super-manager', branch_id: BRANCH_A } }));
  assert.equal(toPeer.status, 403);

  const toBarber = await runChain('create', fakeReq({ actor: 'superManager', body: { role: 'barber', branch_id: BRANCH_A } }));
  assert.equal(toBarber.nextCalled, true);
});

test('non-superusers cannot modify an employee whose role is at or above their own', async () => {
  const result = await runChain('update', fakeReq({
    actor: 'superManager',
    params: { id: 'target-super' },
    body: { role: 'barber', branch_id: BRANCH_A },
  }));
  assert.equal(result.status, 403);
});

test('only admin_network may modify an admin_network account', async () => {
  const byAdmin = await runChain('update', fakeReq({
    actor: 'admin',
    params: { id: 'target-network' },
    body: { role: 'admin', branch_id: BRANCH_A },
  }));
  assert.equal(byAdmin.status, 403);

  const archive = await runChain('delete', fakeReq({ actor: 'admin', params: { id: 'target-network' } }));
  assert.equal(archive.status, 403);
});

test('branch roles are confined to their own branch', async () => {
  const otherTarget = await runChain('update', fakeReq({
    actor: 'manager',
    params: { id: 'target-other-branch' },
    body: { role: 'barber', branch_id: BRANCH_B },
  }));
  assert.equal(otherTarget.status, 403, 'target in another branch');

  const moveAway = await runChain('update', fakeReq({
    actor: 'manager',
    params: { id: TARGET_ID },
    body: { role: 'barber', branch_id: BRANCH_B },
  }));
  assert.equal(moveAway.status, 403, 'moving employee to another branch');

  const sameBranch = await runChain('update', fakeReq({
    actor: 'manager',
    params: { id: TARGET_ID },
    body: { role: 'barber', branch_id: BRANCH_A },
  }));
  assert.equal(sameBranch.nextCalled, true);
});

test('branch roles list only their own branch', async () => {
  const otherBranch = await runChain('read', fakeReq({ actor: 'manager', query: { branch_id: BRANCH_B } }));
  assert.equal(otherBranch.status, 403);

  const req = fakeReq({ actor: 'manager' });
  const ownBranch = await runChain('read', req);
  assert.equal(ownBranch.nextCalled, true);
  assert.equal(req.employeeManagement.branchId, BRANCH_A);
});

test('network roles may list any branch or all branches', async () => {
  const req = fakeReq({ actor: 'superManager' });
  const result = await runChain('read', req);
  assert.equal(result.nextCalled, true);
  assert.equal(req.employeeManagement.branchId, null);
});

test('non-superusers cannot grant permissions they do not hold', async () => {
  const escalate = await runChain('create', fakeReq({
    actor: 'superManager',
    body: { role: 'barber', branch_id: BRANCH_A, permissions: ['queue.read', 'employees.delete'] },
  }));
  assert.equal(escalate.status, 403);

  const csvEscalate = await runChain('create', fakeReq({
    actor: 'superManager',
    body: { role: 'barber', branch_id: BRANCH_A, permissions: 'employees.read,employees.delete' },
  }));
  assert.equal(csvEscalate.status, 403, 'comma-separated multipart form');

  const subset = await runChain('create', fakeReq({
    actor: 'superManager',
    body: { role: 'barber', branch_id: BRANCH_A, permissions: ['employees.read'] },
  }));
  assert.equal(subset.nextCalled, true);
});

test('dashboard users without employees.read can still read the employee directory', async () => {
  ACTORS.directoryOnly = {
    user: { id: 'u-directory', role: 'manager', branch_id: BRANCH_A },
    permissions: ['dashboard.access', 'expenses.read'],
  };
  const req = fakeReq({ actor: 'directoryOnly' });
  const result = await runChain('read', req);
  assert.equal(result.nextCalled, true);
  assert.equal(req.employeeManagement.branchId, BRANCH_A, 'still pinned to own branch');

  const write = await runChain('update', fakeReq({ actor: 'directoryOnly', params: { id: TARGET_ID }, body: {} }));
  assert.equal(write.status, 403, 'dashboard.access does not grant writes');
});

test('targets with roles outside the employee hierarchy cannot be managed', async () => {
  TARGETS['target-merchant'] = { id: 'target-merchant', role: 'merchant', branch_id: BRANCH_A };
  const result = await runChain('update', fakeReq({
    actor: 'manager',
    params: { id: 'target-merchant' },
    body: { role: 'barber', branch_id: BRANCH_A },
  }));
  assert.equal(result.status, 403);
});

test('admins cannot archive or delete their own account', async () => {
  TARGETS['u-admin'] = { id: 'u-admin', role: 'admin', branch_id: BRANCH_A };
  const result = await runChain('delete', fakeReq({ actor: 'admin', params: { id: 'u-admin' } }));
  assert.equal(result.status, 403);
});

test('non-UUID ids are rejected before touching the database', async () => {
  const guard = createEmployeeManagementGuard({
    secret: SECRET,
    loadActor: async () => ACTORS.network,
    loadTarget: async () => { throw new Error('invalid input syntax for type uuid'); },
    validateId: true,
  });
  const result = await run(guard.authorize('delete'), fakeReq({ actor: 'network', params: { id: 'not-a-uuid' } }));
  assert.equal(result.status, 404);
});

test('unknown target returns 404', async () => {
  const result = await runChain('delete', fakeReq({ actor: 'network', params: { id: 'missing' } }));
  assert.equal(result.status, 404);
});

test('employee management routes reject anonymous requests through the app', async () => {
  const notifications = require('../src/models/notifications');
  notifications.ensureNotificationsTable = async () => {};
  const app = require('../src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const routes = [
      ['GET', '/api/barbers'],
      ['POST', '/api/barbers/register'],
      ['PATCH', `/api/barbers/${TARGET_ID}`],
      ['DELETE', `/api/barbers/${TARGET_ID}`],
      ['PATCH', `/api/barbers/${TARGET_ID}/archive`],
      ['PATCH', `/api/barbers/${TARGET_ID}/restore`],
    ];
    for (const [method, path] of routes) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({ login: 'x', password: 'xxxxxx', name: 'x', role: 'admin', branch_id: BRANCH_A }),
      });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
