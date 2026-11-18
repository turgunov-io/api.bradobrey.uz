const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.PGDATABASE ||= 'phase0-marketplace-admin-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'phase0-marketplace-admin-tests';
process.env.JWT_SECRET ||= 'phase0-marketplace-admin-secret';

const { db, pool } = require('../src/config/postgres');
const reports = require('../src/models/marketplace/adminReports');
const fraudAlerts = require('../src/models/marketplace/fraudAlerts');
const marketplaceClients = require('../src/models/marketplace/clients');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';

function chain(response, calls, table) {
  const query = {
    eq(column, value) { calls.push({ table, method: 'eq', column, value }); return this; },
    maybeSingle() { return this; },
    order() { return this; },
    or() { return this; },
    range() { return this; },
    select() { return this; },
    update(value) { calls.push({ table, method: 'update', value }); return this; },
    then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); },
  };
  return query;
}

// `dbRole` is what the database says; the token may claim something else.
function installMocks({ dbRole, archived = false }) {
  const calls = [];
  const sql = [];
  const originalFrom = db.from;
  const originalQuery = pool.query;
  db.from = (table) => {
    calls.push({ table, method: 'from' });
    if (table === 'users') {
      return chain({ data: dbRole ? { id: USER_ID, login: 'u', role: dbRole, branch_id: null } : null, error: null }, calls, table);
    }
    if (table === 'barbers') {
      return chain({ data: archived ? { id: USER_ID, is_archived: true } : null, error: null }, calls, table);
    }
    if (table === 'marketplace_clients') {
      return chain({ data: [{ id: CLIENT_ID, phone: '+998' }], error: null, count: 1 }, calls, table);
    }
    return chain({ data: null, error: null }, calls, table);
  };
  pool.query = async (text) => {
    sql.push(String(text));
    return { rows: [] };
  };
  return {
    calls,
    sql,
    touchedClients: () => calls.some((call) => call.table === 'marketplace_clients') || sql.length > 0,
    restore() { db.from = originalFrom; pool.query = originalQuery; },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

const tokenFor = (role) => jwt.sign({ sub: USER_ID, role }, process.env.JWT_SECRET);
const reqFor = (role, extra = {}) => ({
  headers: { authorization: `Bearer ${tokenFor(role)}` },
  query: {},
  params: { id: CLIENT_ID },
  body: { status: 'REVIEWED' },
  ...extra,
});

const ENDPOINTS = [
  ['GET /admin/mobile-users', (req, res) => reports.listMobileUsers(req, res)],
  ['GET /admin/reviews', (req, res) => reports.listReviews(req, res)],
  ['POST /admin/mobile-users/:id/test-notification', (req, res) => reports.sendTestNotification(req, res)],
  ['GET /admin/fraud-alerts', (req, res) => fraudAlerts.list(req, res)],
  ['PATCH /admin/fraud-alerts/:id', (req, res) => fraudAlerts.review(req, res)],
  ['GET /marketplace/clients', (req, res) => marketplaceClients.list(req, res)],
  ['GET /marketplace/clients/:id', (req, res) => marketplaceClients.getById(req, res)],
  ['POST /marketplace/clients/:id/activate', (req, res) => marketplaceClients.activate(req, res)],
  ['POST /marketplace/clients/:id/deactivate', (req, res) => marketplaceClients.deactivate(req, res)],
];

for (const [name, handler] of ENDPOINTS) {
  for (const role of ['admin_branch', 'merchant', 'manager', 'barber']) {
    test(`${name} forbids branch-scoped role ${role}`, async () => {
      const mocks = installMocks({ dbRole: role });
      try {
        const res = createResponse();
        await handler(reqFor(role), res);
        assert.equal(res.statusCode, 403);
        assert.equal(mocks.touchedClients(), false);
      } finally {
        mocks.restore();
      }
    });
  }

  test(`${name} uses the DB role, not the token role (token says admin_network, DB says merchant)`, async () => {
    const mocks = installMocks({ dbRole: 'merchant' });
    try {
      const res = createResponse();
      await handler(reqFor('admin_network'), res);
      assert.equal(res.statusCode, 403);
      assert.equal(mocks.touchedClients(), false);
    } finally {
      mocks.restore();
    }
  });

  test(`${name} rejects tokens for users that no longer exist`, async () => {
    const mocks = installMocks({ dbRole: null });
    try {
      const res = createResponse();
      await handler(reqFor('admin_network'), res);
      assert.equal(res.statusCode, 401);
      assert.equal(mocks.touchedClients(), false);
    } finally {
      mocks.restore();
    }
  });

  test(`${name} allows a network administrator`, async () => {
    const mocks = installMocks({ dbRole: 'admin_network' });
    try {
      const res = createResponse();
      await handler(reqFor('merchant'), res);
      assert.notEqual(res.statusCode, 401);
      assert.notEqual(res.statusCode, 403);
    } finally {
      mocks.restore();
    }
  });
}

test('marketplace admin endpoints reject missing tokens', async () => {
  for (const [name, handler] of ENDPOINTS) {
    const res = createResponse();
    await handler({ headers: {}, query: {}, params: {}, body: {} }, res);
    assert.equal(res.statusCode, 401, name);
  }
});
