const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

require('dotenv').config();

const SECRET = 'staff-access-test-secret-0123456789abcdef0123';
process.env.JWT_SECRET = process.env.JWT_SECRET || SECRET;

const { createStaffAccessGuard } = require('../src/middleware/staffAccess');

const ACTORS = {
  admin: { user: { id: '10000000-0000-4000-8000-000000000001', role: 'admin', branch_id: null, company_id: 'company-1', company_status: 'active' }, permissions: [] },
  narrowAdmin: {
    user: { id: '10000000-0000-4000-8000-000000000002', role: 'admin', branch_id: null, company_id: 'company-1', company_status: 'active' },
    permissions: ['dashboard.access', 'services.read'],
  },
  manager: {
    user: { id: '10000000-0000-4000-8000-000000000003', role: 'manager', branch_id: null, company_id: 'company-1', company_status: 'active' },
    permissions: ['dashboard.access', 'services.manage'],
  },
  barber: {
    user: { id: '10000000-0000-4000-8000-000000000004', role: 'barber', branch_id: null, company_id: 'company-1', company_status: 'active' },
    permissions: ['queue.read'],
  },
  merchant: { user: { id: '10000000-0000-4000-8000-000000000005', role: 'merchant', branch_id: null, company_id: 'company-1', company_status: 'active' }, permissions: [] },
};

const GHOST_ID = '10000000-0000-4000-8000-0000000000ff';

function makeGuard() {
  return createStaffAccessGuard({
    secret: SECRET,
    loadActor: async (userId) => Object.values(ACTORS).find((actor) => actor.user.id === userId) || null,
  });
}

const sign = (payload) => jwt.sign(payload, SECRET, { expiresIn: '1h' });
const tokenFor = (key) => sign({ sub: ACTORS[key].user.id, role: ACTORS[key].user.role });

function fakeReq(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function run(middleware, token) {
  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

test('authenticated rejects a request without a token', async () => {
  const { res, nextCalled } = await run(makeGuard().authenticated(), null);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('authenticated rejects a token signed with another secret', async () => {
  const forged = jwt.sign({ sub: ACTORS.admin.user.id, role: 'admin' }, 'another-secret');
  const { res, nextCalled } = await run(makeGuard().authenticated(), forged);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('authenticated rejects a token whose user no longer exists', async () => {
  const { res } = await run(makeGuard().authenticated(), sign({ sub: GHOST_ID, role: 'admin' }));
  assert.equal(res.statusCode, 401);
});

test('authenticated rejects a non-uuid subject without querying the database', async () => {
  let queried = false;
  const guard = createStaffAccessGuard({ secret: SECRET, loadActor: async () => { queried = true; return null; } });
  const { res } = await run(guard.authenticated(), sign({ sub: 'client-123', role: 'marketplace_client' }));
  assert.equal(res.statusCode, 401);
  assert.equal(queried, false);
});

test('authenticated accepts any existing user and exposes the database role', async () => {
  for (const key of ['admin', 'barber', 'merchant']) {
    const { req, nextCalled } = await run(makeGuard().authenticated(), tokenFor(key));
    assert.equal(nextCalled, true, key);
    assert.equal(req.staffAccess.role, ACTORS[key].user.role);
  }
});

test('requireStaff uses the database role, not the role claimed in the token', async () => {
  const escalated = sign({ sub: ACTORS.barber.user.id, role: 'admin' });
  const { res, nextCalled } = await run(makeGuard().requireStaff(), escalated);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('requireStaff rejects barbers and merchants', async () => {
  for (const key of ['barber', 'merchant']) {
    const { res } = await run(makeGuard().requireStaff(), tokenFor(key));
    assert.equal(res.statusCode, 403, key);
  }
});

test('requireStaff lets a superuser without permission rows through any permission check', async () => {
  const { nextCalled } = await run(makeGuard().requireStaff({ anyOf: ['services.manage'] }), tokenFor('admin'));
  assert.equal(nextCalled, true);
});

test('requireStaff honours narrowed permission rows of a superuser', async () => {
  const { res } = await run(makeGuard().requireStaff({ anyOf: ['services.manage'] }), tokenFor('narrowAdmin'));
  assert.equal(res.statusCode, 403);
});

test('requireStaff accepts a branch role holding one of the permissions', async () => {
  const guard = makeGuard();
  assert.equal((await run(guard.requireStaff({ anyOf: ['promo.manage', 'services.manage'] }), tokenFor('manager'))).nextCalled, true);
  assert.equal((await run(guard.requireStaff({ anyOf: ['promo.manage'] }), tokenFor('manager'))).res.statusCode, 403);
});

test('requireSuperuser rejects a manager and accepts an admin', async () => {
  const guard = makeGuard();
  assert.equal((await run(guard.requireSuperuser(), tokenFor('manager'))).res.statusCode, 403);
  assert.equal((await run(guard.requireSuperuser(), tokenFor('admin'))).nextCalled, true);
});

test('a failing actor lookup answers 500 without leaking the error', async () => {
  const guard = createStaffAccessGuard({ secret: SECRET, loadActor: async () => { throw new Error('relation users does not exist'); } });
  const original = console.error;
  console.error = () => {};
  try {
    const { res } = await run(guard.authenticated(), tokenFor('admin'));
    assert.equal(res.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /relation/);
  } finally {
    console.error = original;
  }
});

// Every C2 route must refuse anonymous callers before touching the database.
const C2_ROUTES = {
  '/api/branches': [
    ['get', '/'], ['get', '/b1'], ['post', '/'], ['patch', '/b1'], ['delete', '/b1'],
    ['post', '/b1/activate'], ['post', '/b1/deactivate'], ['get', '/b1/location'], ['put', '/b1/location'],
  ],
  '/api/services': [
    ['get', '/'], ['patch', '/reorder'], ['get', '/s1'], ['post', '/'], ['patch', '/s1'], ['delete', '/'], ['delete', '/s1'],
  ],
  '/api/service-categories': [['get', '/'], ['post', '/'], ['patch', '/c1'], ['delete', '/c1']],
  '/api/warehouse': [
    ['get', '/summary'], ['get', '/categories'], ['post', '/categories'], ['patch', '/categories/x'],
    ['delete', '/categories'], ['delete', '/categories/x'], ['get', '/positions'], ['post', '/positions'],
    ['patch', '/positions/x'], ['delete', '/positions'], ['delete', '/positions/x'], ['get', '/templates'],
    ['get', '/templates/x'], ['post', '/templates'], ['patch', '/templates/x'], ['delete', '/templates'],
    ['delete', '/templates/x'], ['get', '/stocks'], ['get', '/stock'], ['post', '/stocks'], ['put', '/stocks'],
    ['get', '/purchases'], ['get', '/purchases/x'], ['post', '/purchases'], ['patch', '/purchases/x'],
    ['delete', '/purchases'], ['delete', '/purchases/x'],
  ],
  '/api/promo-code': [
    ['post', '/validate'], ['post', '/use'], ['get', '/dashboard'], ['get', '/dashboard/p1'],
    ['post', '/dashboard/create'], ['patch', '/dashboard/p1'], ['delete', '/dashboard/p1'],
  ],
  '/api/finance': [['get', '/overview'], ['get', '/'], ['post', '/']],
};

const ROUTER_MODULES = {
  '/api/branches': '../src/routers/branches',
  '/api/services': '../src/routers/services',
  '/api/service-categories': '../src/routers/serviceCategories',
  '/api/warehouse': '../src/routers/warehouse',
  '/api/promo-code': '../src/routers/promocode',
  '/api/finance': '../src/routers/finance',
};

async function request(server, method, path) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: method.toUpperCase(),
    headers: { 'content-type': 'application/json' },
    body: method === 'get' ? undefined : '{}',
  });
  await response.arrayBuffer();
  return response.status;
}

test('every C2 route answers 401 to anonymous requests', async () => {
  const app = express();
  app.use(express.json());
  for (const [mount, modulePath] of Object.entries(ROUTER_MODULES)) app.use(mount, require(modulePath));

  const server = app.listen(0);
  try {
    for (const [mount, routes] of Object.entries(C2_ROUTES)) {
      for (const [method, path] of routes) {
        const status = await request(server, method, `${mount}${path}`);
        assert.equal(status, 401, `${method.toUpperCase()} ${mount}${path}`);
      }
    }
  } finally {
    server.close();
  }
});
