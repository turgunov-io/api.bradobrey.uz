// MULTI_TENANCY Phase 1 step B2b: company data scoping for statistics,
// history, employee quality, notifications, cashback settlements, marketplace
// admin views, warehouse, expenses, finance, merchant, barber location,
// employee registration and jobs. Every test is a two-company scenario:
// "company B admin cannot see company A's X".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'company-data-scope-secret';
const SECRET = process.env.JWT_SECRET;

const postgres = require('../src/config/postgres');
const statistics = require('../src/models/statistics');
const history = require('../src/models/history');
const employeeQuality = require('../src/models/employeeQuality');
const { requireAccessCompanyId } = require('../src/utils/employeeQualityAccess');
const notifications = require('../src/models/notifications');
const reconciliation = require('../src/services/cashbackReconciliation');
const { createReconciliationRoutes } = require('../src/routers/cashbackSettlements');
const reports = require('../src/models/marketplace/adminReports');
const fraudAlerts = require('../src/models/marketplace/fraudAlerts');
const marketplaceClients = require('../src/models/marketplace/clients');
const { companyMarketplaceClientIdsSql } = require('../src/utils/marketplaceCompanyScope');
const warehouse = require('../src/models/warehouse');
const expenses = require('../src/models/expenses');
const finance = require('../src/models/finance');
const merchant = require('../src/models/merchant');
const location = require('../src/services/barberLocation');
const barbers = require('../src/models/barbers');
const { groupTargetsByTimezone, closePreviousDayOpenQueueEntries } = require('../src/jobs/autoCloseQueue');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const ADMIN_B = '20000000-0000-4000-8000-00000000000b';
const SHOP_A = '5a5a5a5a-0000-4000-8000-00000000000a';
const SHOP_B = '5b5b5b5b-0000-4000-8000-00000000000b';

const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send() { return this; },
  };
}

// Routes every SQL statement (raw and query-builder) through `handler`.
async function withSql(handler, fn) {
  const original = postgres.pool.query;
  const seen = [];
  postgres.pool.query = async (sql, params = []) => {
    const text = String(sql);
    seen.push({ sql: text, params });
    return (await handler(text, params)) || { rows: [] };
  };
  try {
    return await fn(seen);
  } finally {
    postgres.pool.query = original;
  }
}

const bearer = (claims) => ({ authorization: `Bearer ${jwt.sign(claims, SECRET, { expiresIn: '1h' })}` });

// ------------------------------------------------------------ statistics etc.

test('requireAccessCompanyId fails closed without a company', () => {
  assert.throws(() => requireAccessCompanyId({ scope: { type: 'global' }, user: {} }), { code: 'COMPANY_SCOPE_MISSING' });
  assert.equal(requireAccessCompanyId({ scope: { type: 'global', companyId: COMPANY_B } }), COMPANY_B);
  assert.equal(requireAccessCompanyId({ scope: { type: 'branch' }, user: { company_id: COMPANY_B } }), COMPANY_B);
});

test('statistics: company B global statistics never read company A queue entries', async () => {
  await withSql(() => ({ rows: [] }), async (seen) => {
    const res = makeRes();
    await statistics.all({
      query: { start_date: '2026-11-01', end_date: '2026-11-02' },
      statisticsAccess: { scope: { type: 'global', companyId: COMPANY_B, branchIds: [BRANCH_B1] }, user: { company_id: COMPANY_B } },
    }, res);
    assert.equal(res.statusCode, 200);
    const entries = seen.find((q) => /FROM "queue_entries"/.test(q.sql));
    assert.match(entries.sql, /t\."company_id" = \$1/);
    assert.equal(entries.params[0], COMPANY_B);
  });
});

test('statistics: a scope without a company is refused (403) before any query', async () => {
  await withSql(() => ({ rows: [] }), async (seen) => {
    const res = makeRes();
    await statistics.all({ query: { start_date: '2026-11-01', end_date: '2026-11-02' }, statisticsAccess: { scope: { type: 'global' }, user: {} } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(seen.length, 0);
  });
});

test('history: company B global history is filtered by company B', async () => {
  await withSql(() => ({ rows: [] }), async (seen) => {
    const res = makeRes();
    await history.all({
      query: {},
      historyAccess: { scope: { type: 'global', branchId: null, companyId: COMPANY_B, branchIds: [BRANCH_B1] }, user: { company_id: COMPANY_B } },
    }, res);
    assert.equal(res.statusCode, 200);
    const entries = seen.find((q) => /FROM "queue_entries"/.test(q.sql));
    assert.match(entries.sql, /t\."company_id" = \$\d+/);
    assert.ok(entries.params.includes(COMPANY_B));
    assert.ok(!entries.params.includes(COMPANY_A));
  });
});

test('employee quality: every predicate is bound to the caller company', () => {
  const { scopePredicate } = employeeQuality._private;
  const params = [];
  const sql = scopePredicate('e', { scope: { type: 'global', companyId: COMPANY_B }, user: { company_id: COMPANY_B } }, params);
  assert.equal(sql, 'e.company_id = $1::uuid');
  assert.deepEqual(params, [COMPANY_B]);
  assert.throws(() => scopePredicate('e', { scope: { type: 'global' }, user: {} }, []), { code: 'COMPANY_SCOPE_MISSING' });

  const model = read('src/models/employeeQuality.js');
  assert.match(model, /and a\.company_id = \$5::uuid/);
  assert.match(model, /and b\.company_id = \$5::uuid/);
  assert.match(model, /where b\.id = \$\$\{params\.length\}::uuid and \$\{company\} and \$\{scope\}/);
  assert.match(model, /employee_id = \$2::uuid and company_id = \$3::uuid/);
});

// ---------------------------------------------------------- notifications

test('notifications: fan-out recipients are users of the event branch company only', async () => {
  const { selectRecipients, RECIPIENTS_FOR_BRANCH_SQL } = notifications._private;
  assert.match(RECIPIENTS_FOR_BRANCH_SQL, /join users u on u\.company_id = b\.company_id/);
  assert.match(RECIPIENTS_FOR_BRANCH_SQL, /where b\.id = \$1/);

  const inserted = [];
  await withSql((sql, params) => {
    if (/join users u on u\.company_id = b\.company_id/.test(sql)) {
      assert.equal(params[0], BRANCH_B1);
      // The DB returns company B staff only; company A's network admin is not a row.
      return { rows: [
        { id: 'b-network', role: 'admin_network', branch_id: null, company_id: COMPANY_B },
        { id: 'b-other-branch-barber', role: 'barber', branch_id: 'other', company_id: COMPANY_B },
      ] };
    }
    if (/insert into notifications/.test(sql)) inserted.push(params);
    if (/FROM "(barbers|branches)"/.test(sql)) return { rows: [{ name: 'X' }] };
    return { rows: [] };
  }, async () => {
    await notifications.createLocationWarningNotifications({ barberId: 'barber-b', branchId: BRANCH_B1, event: { id: 'ev' } });
  });
  assert.deepEqual(inserted.map((params) => params[0]), ['b-network']);
  assert.equal(inserted[0][5], COMPANY_B);
  assert.deepEqual(selectRecipients([{ id: 'x', role: 'barber', branch_id: BRANCH_A1 }], BRANCH_B1, ['admin']), []);
});

test('notifications: checkToday re-checks only the caller company orders', async () => {
  await withSql((sql) => {
    if (/join companies c on c\.id = u\.company_id/.test(sql)) return { rows: [{ company_id: COMPANY_B }] };
    return { rows: [] };
  }, async (seen) => {
    const res = makeRes();
    await notifications.notifications.checkToday({ headers: bearer({ sub: ADMIN_B, role: 'admin_network' }), employeeAccess: { user: { id: ADMIN_B, role: 'admin_network' }, sessionValid: true }, body: { date: '2026-11-18' } }, res);
    assert.equal(res.statusCode, 200);
    const orders = seen.find((q) => /FROM "queue_entries"/.test(q.sql));
    assert.match(orders.sql, /t\."company_id" = \$1/);
    assert.equal(orders.params[0], COMPANY_B);
  });
});

test('notifications: checkToday without an active company is refused', async () => {
  await withSql(() => ({ rows: [] }), async (seen) => {
    const res = makeRes();
    await notifications.notifications.checkToday({ headers: bearer({ sub: ADMIN_B, role: 'admin_network' }), employeeAccess: { user: { id: ADMIN_B, role: 'admin_network' }, sessionValid: true }, body: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.ok(!seen.some((q) => /queue_entries/.test(q.sql)));
  });
});

// ---------------------------------------------------- cashback reconciliation

test('reconciliation: alerts and runs are per company; companyId is mandatory', async () => {
  await assert.rejects(() => reconciliation.listReconciliationAlerts({ status: 'OPEN' }), /companyId is required/);
  await withSql(() => ({ rows: [] }), async (seen) => {
    await reconciliation.listReconciliationAlerts({ status: 'OPEN', companyId: COMPANY_B });
    assert.match(seen[0].sql, /a\.company_id = \$3/);
    assert.equal(seen[0].params[2], COMPANY_B);
  });

  const statements = [];
  const client = { async query(sql, params) { statements.push({ sql: String(sql), params }); return { rows: [], rowCount: 0 }; }, release() {} };
  const originalConnect = postgres.pool.connect;
  postgres.pool.connect = async () => client;
  try {
    await withSql((sql) => (/from companies/.test(sql) ? { rows: [{ id: COMPANY_A }, { id: COMPANY_B }] } : { rows: [] }), async () => {
      const results = await reconciliation.reconcileAllCompanies({ actor: 'test' });
      assert.deepEqual(results.map((r) => r.companyId), [COMPANY_A, COMPANY_B]);
    });
  } finally {
    postgres.pool.connect = originalConnect;
  }
  const ledgerQueries = statements.filter((s) => /with ledger as/.test(s.sql));
  assert.equal(ledgerQueries.length, 2);
  assert.match(ledgerQueries[0].sql, /from cashback_transactions\s+where company_id = \$2/);
  assert.match(ledgerQueries[0].sql, /from cashback_wallets where company_id = \$2/);
  assert.deepEqual(ledgerQueries.map((q) => q.params[1]), [COMPANY_A, COMPANY_B]);
});

test('reconciliation routes: DB-loaded admin, company B only; token role is not trusted', async () => {
  const routes = [];
  const fakeRouter = {
    get: (p, h) => routes.push({ method: 'get', path: p, handler: h }),
    post: (p, h) => routes.push({ method: 'post', path: p, handler: h }),
  };
  const calls = [];
  let actor = { id: ADMIN_B, sub: ADMIN_B, role: 'admin', companyId: COMPANY_B };
  createReconciliationRoutes(fakeRouter, {
    authorize: async (_req, res) => {
      if (!actor) { res.status(403).json({ error: 'Only network admins can reconcile cashback' }); return null; }
      return actor;
    },
    service: {
      listReconciliationAlerts: async (args) => { calls.push(['list', args]); return []; },
      reconcileCashbackBalances: async (args) => { calls.push(['run', args]); return { discrepancies: 0 }; },
    },
  });
  const alerts = routes.find((r) => r.path === '/reconciliation/alerts').handler;
  const run = routes.find((r) => r.path === '/reconciliation/run').handler;

  const ok = makeRes();
  await alerts({ query: {} }, ok, (error) => { throw error; });
  await run({ query: {} }, makeRes(), (error) => { throw error; });
  assert.equal(calls[0][1].companyId, COMPANY_B);
  assert.equal(calls[1][1].companyId, COMPANY_B);

  actor = null; // DB says not a network admin (whatever the token claims)
  const denied = makeRes();
  await run({ query: {}, headers: bearer({ sub: ADMIN_B, role: 'admin_network' }) }, denied, () => {});
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(read('src/routers/cashbackSettlements.js'), /verifyAny/);
});

// ------------------------------------------------------- marketplace admin

// createAdminAuth loads the caller through db.from (users, companies, barbers).
function withAdmin(role, companyId, fn) {
  const originalFrom = postgres.db.from;
  const chain = (data) => ({
    select() { return this; }, eq() { return this; }, maybeSingle() { return this; },
    then(resolve, reject) { return Promise.resolve({ data, error: null }).then(resolve, reject); },
  });
  postgres.db.from = (table) => {
    if (table === 'users') return chain({ id: ADMIN_B, login: 'b', role, branch_id: null, company_id: companyId });
    if (table === 'companies') return chain({ id: companyId, status: 'active' });
    if (table === 'barbers') return chain(null);
    return originalFrom.call(postgres.db, table);
  };
  return Promise.resolve(fn()).finally(() => { postgres.db.from = originalFrom; });
}

const adminReq = (extra = {}) => ({ headers: bearer({ sub: ADMIN_B, role: 'admin' }), query: {}, params: { id: '22222222-2222-4222-8222-222222222222' }, body: { status: 'REVIEWED' }, ...extra });

test('marketplace company rule: bookings, origins, reviews, legacy clients of the company', () => {
  const sql = companyMarketplaceClientIdsSql('$7');
  assert.match(sql, /mq\.company_id = \$7::uuid/);
  assert.match(sql, /o\.company_id = \$7::uuid/);
  assert.match(sql, /rv\.company_id = \$7::uuid/);
  assert.match(sql, /lc\.company_id = \$7::uuid/);
  assert.throws(() => companyMarketplaceClientIdsSql("'x'"));
});

test('marketplace admin: company B admin only sees company B clients, reviews and fraud alerts', async () => {
  await withAdmin('admin', COMPANY_B, () => withSql(() => ({ rows: [] }), async (seen) => {
    const handlers = [
      (res) => reports.listMobileUsers(adminReq(), res),
      (res) => reports.listReviews(adminReq(), res),
      (res) => reports.sendTestNotification(adminReq({ body: { title: 't', body: 'b' } }), res),
      (res) => fraudAlerts.list(adminReq(), res),
      (res) => fraudAlerts.review(adminReq(), res),
      (res) => marketplaceClients.list(adminReq(), res),
      (res) => marketplaceClients.getById(adminReq(), res),
      (res) => marketplaceClients.deactivate(adminReq(), res),
    ];
    for (const handler of handlers) {
      const before = seen.length;
      const res = makeRes();
      await handler(res);
      const statements = seen.slice(before);
      assert.ok(statements.length > 0, 'a query ran');
      for (const statement of statements) {
        assert.ok(statement.params.includes(COMPANY_B), statement.sql);
        assert.ok(!statement.params.includes(COMPANY_A));
      }
      // Clients that are not company B's are invisible: 404 for single-item calls.
      if (handler.toString().includes('getById') || handler.toString().includes('deactivate') || handler.toString().includes('sendTestNotification')) {
        assert.equal(res.statusCode, 404);
      }
    }
    const reviews = seen.find((q) => /r\.rating = \$3::int/.test(q.sql));
    assert.match(reviews.sql, /r\.company_id = \$6::uuid/);
  }));
});

// ---------------------------------------------------------------- warehouse

const tenantReq = (companyId, extra = {}) => ({ tenant: { companyId, isPlatformOwner: false }, query: {}, params: {}, body: {}, ...extra });

test('warehouse: company B lists and edits only company B rows', async () => {
  await withSql(() => ({ rows: [] }), async (seen) => {
    await warehouse.listPositions(tenantReq(COMPANY_B), makeRes());
    await warehouse.listCategories(tenantReq(COMPANY_B), makeRes());
    await warehouse.listTemplates(tenantReq(COMPANY_B), makeRes());
    await warehouse.listStocks(tenantReq(COMPANY_B), makeRes());
    await warehouse.listPurchases(tenantReq(COMPANY_B), makeRes());
    await warehouse.summary(tenantReq(COMPANY_B), makeRes());
    for (const statement of seen) {
      assert.equal(statement.params[0], COMPANY_B, statement.sql);
      assert.match(statement.sql, /company_id = \$1/);
    }

    const before = seen.length;
    const notFound = makeRes();
    await warehouse.updatePosition(tenantReq(COMPANY_B, { params: { id: 'pos-of-a' }, body: { name: 'x' } }), notFound);
    assert.equal(notFound.statusCode, 404);
    assert.match(seen[before].sql, /where id = \$\d+ and company_id = \$\d+/);
    assert.ok(seen[before].params.includes(COMPANY_B));
  });
});

test('warehouse: inserts are stamped with the caller company', async () => {
  await withSql((sql) => (/insert into warehouse_positions/.test(sql) ? { rows: [{ id: 'p1', name: 'Gel' }] } : { rows: [] }), async (seen) => {
    const res = makeRes();
    await warehouse.createPosition(tenantReq(COMPANY_B, { body: { name: 'Gel', sku: 'G-1' } }), res);
    assert.equal(res.statusCode, 201);
    const insert = seen.find((q) => /insert into warehouse_positions/.test(q.sql));
    assert.match(insert.sql, /company_id\)/);
    assert.equal(insert.params.at(-1), COMPANY_B);
  });
});

test('warehouse: company B cannot stock or purchase into a company A branch or position', async () => {
  await withSql((sql) => {
    if (/from branches where id = \$1 and company_id = \$2/.test(sql)) return { rows: [] };
    if (/from warehouse_positions where id = any/.test(sql)) return { rows: [{ count: 0 }] };
    return { rows: [] };
  }, async (seen) => {
    const stock = makeRes();
    await warehouse.setStock(tenantReq(COMPANY_B, { body: { branch_id: BRANCH_A1, position_id: 'p', quantity: 1 } }), stock);
    assert.equal(stock.statusCode, 403);
    const purchase = makeRes();
    await warehouse.createPurchase(tenantReq(COMPANY_B, { body: { items: [{ position_id: 'pos-of-a', quantity: 1 }] } }), purchase);
    assert.equal(purchase.statusCode, 404);
    assert.ok(!seen.some((q) => /insert into/.test(q.sql)));
  });
});

test('warehouse: no company -> 403; no runtime DDL re-creating global unique indexes', async () => {
  await withSql(() => ({ rows: [] }), async (seen) => {
    const res = makeRes();
    await warehouse.listPositions({ query: {}, params: {}, body: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(seen.length, 0);
  });
  const model = read('src/models/warehouse.js');
  assert.doesNotMatch(model, /create (unique )?index/i);
  assert.doesNotMatch(model, /ensureCategoriesTable/);
  const sql = read('db/postgres/warehouse.sql');
  assert.doesNotMatch(sql, /create unique index if not exists idx_warehouse_positions_sku/i);
  assert.doesNotMatch(sql, /create unique index if not exists idx_warehouse_categories_name/i);
  const migration = read('db/migrations/006_warehouse_categories_company.sql');
  assert.match(migration, /warehouse_categories_company_name_uidx\s+on warehouse_categories \(company_id, lower\(name\)\)/);
});

// ----------------------------------------------------------------- expenses

function withUser(user, fn) {
  const originalFrom = postgres.db.from;
  const chain = (data) => ({
    select() { return this; }, eq() { return this; }, maybeSingle() { return this; },
    then(resolve, reject) { return Promise.resolve({ data, error: null }).then(resolve, reject); },
  });
  postgres.db.from = (table) => (table === 'users' ? chain(user) : chain([]));
  return Promise.resolve(fn()).finally(() => { postgres.db.from = originalFrom; });
}

test('expenses: network admins see company-level (branch NULL) rows of THEIR company only', async () => {
  const user = { id: ADMIN_B, role: 'admin_network', branch_id: null, company_id: COMPANY_B };
  await withUser(user, () => withSql((sql) => (/select id from branches where company_id/.test(sql) ? { rows: [{ id: BRANCH_B1 }] } : { rows: [] }), async (seen) => {
    const res = makeRes();
    await expenses.list({ headers: bearer({ sub: ADMIN_B, role: 'admin_network' }), query: {} }, res);
    assert.equal(res.statusCode, 200);
    const list = seen.find((q) => /from warehouse_purchases p/.test(q.sql));
    assert.match(list.sql, /p\.company_id = \$2/);
    assert.equal(list.params[1], COMPANY_B);
    // No branch allow-list for a company-wide scope -> branch_id NULL rows stay visible.
    assert.doesNotMatch(list.sql, /p\.branch_id::text = any/);
  }));
});

test('expenses: company B admin cannot update or delete a company A expense', async () => {
  const user = { id: ADMIN_B, role: 'admin', branch_id: null, company_id: COMPANY_B };
  await withUser(user, () => withSql((sql) => (/select id from branches where company_id/.test(sql) ? { rows: [{ id: BRANCH_B1 }] } : { rows: [] }), async (seen) => {
    const res = makeRes();
    await expenses.remove({ headers: bearer({ sub: ADMIN_B, role: 'admin' }), params: { id: 'expense-of-a' }, query: {} }, res);
    assert.equal(res.statusCode, 404);
    const del = seen.find((q) => /delete from warehouse_purchases/.test(q.sql));
    assert.match(del.sql, /company_id = \$3/);
    assert.equal(del.params[2], COMPANY_B);
  }));
});

// ------------------------------------------------------------------ finance

test('finance: overview is bound to the caller company; snapshots cannot target another company branch', async () => {
  await withSql((sql) => (/from branches where id = \$1 and company_id = \$2/.test(sql) ? { rows: [] } : { rows: [] }), async (seen) => {
    const companyWide = Object.defineProperty([BRANCH_B1], 'companyWide', { value: true });
    const res = makeRes();
    await finance.overview({ tenant: { companyId: COMPANY_B }, branchScope: companyWide, query: {} }, res);
    assert.equal(res.statusCode, 200);
    const overviewSql = seen.filter((q) => /queue_entries|finance_snapshots|warehouse_purchases/.test(q.sql));
    assert.equal(overviewSql.length, 4);
    for (const statement of overviewSql) assert.ok(statement.params.includes(COMPANY_B), statement.sql);
    const purchases = overviewSql.find((q) => /from warehouse_purchases/.test(q.sql));
    assert.equal(purchases.params[2], null, 'company-wide: NULL-branch purchases of the company are included');

    const upsert = makeRes();
    await finance.upsert({ tenant: { companyId: COMPANY_B }, body: { branch_id: BRANCH_A1, period: '2026-11' } }, upsert);
    assert.equal(upsert.statusCode, 403);
    assert.ok(!seen.some((q) => /finance_snapshots.*ON CONFLICT|INSERT INTO "finance_snapshots"/i.test(q.sql)));
  });
});

// ----------------------------------------------------------------- merchant

test('merchant: the barbershop always resolves inside the user company (never "the only one")', async () => {
  const { resolveMerchantBarbershopId, resolveSingleBarbershopId } = merchant._private;
  await withSql((sql, params) => {
    if (/from marketplace_barbershops\s+where company_id = \$1/.test(sql)) return { rows: params[0] === COMPANY_B ? [{ id: SHOP_B }] : [{ id: SHOP_A }] };
    if (/from marketplace_barbershops where id = \$1 and company_id = \$2/.test(sql)) {
      const owner = { [SHOP_A]: COMPANY_A, [SHOP_B]: COMPANY_B }[params[0]];
      return { rows: owner === params[1] ? [{}] : [] };
    }
    return { rows: [] };
  }, async () => {
    assert.equal(await resolveSingleBarbershopId(COMPANY_B), SHOP_B);
    assert.equal(await resolveSingleBarbershopId(null), null);
    assert.equal(await resolveMerchantBarbershopId({ id: ADMIN_B, company_id: COMPANY_B, branch_id: null }), SHOP_B);
    // An assignment pointing at company A's barbershop is denied.
    assert.equal(await resolveMerchantBarbershopId({ id: ADMIN_B, company_id: COMPANY_B, marketplace_barbershop_id: SHOP_A }), null);
    assert.equal(await resolveMerchantBarbershopId({ id: ADMIN_B, company_id: null }), null);
  });
});

// ---------------------------------------------------------- barber location

test('barber location: company B admin cannot configure or read a company A branch', async () => {
  await withSql((sql) => {
    if (/from users u\s+left join companies c/.test(sql)) return { rows: [{ id: ADMIN_B, role: 'admin_network', branch_id: null, company_id: COMPANY_B, company_status: 'active' }] };
    if (/from branches where id = \$1 and company_id = \$2/.test(sql)) return { rows: [] };
    return { rows: [] };
  }, async (seen) => {
    const save = makeRes();
    await location.saveBranchLocation({ headers: bearer({ sub: ADMIN_B, role: 'admin_network' }), params: { id: BRANCH_A1 }, body: { latitude: 41, longitude: 69, radius_meters: 100 } }, save);
    assert.equal(save.statusCode, 403);
    const get = makeRes();
    await location.getBranchLocation({ headers: bearer({ sub: ADMIN_B, role: 'admin_network' }), params: { id: BRANCH_A1 } }, get);
    assert.equal(get.statusCode, 403);
    assert.ok(!seen.some((q) => /branch_locations/.test(q.sql)));
  });
});

// ---------------------------------------------------- employee registration

test('register: login uniqueness is checked inside the creator company and the user is stamped', async () => {
  const original = postgres.db.from;
  const calls = [];
  const chain = (table) => {
    const state = { table, eq: [], insert: null };
    calls.push(state);
    const q = {
      select() { return q; },
      eq(column, value) { state.eq.push([column, value]); return q; },
      in() { return q; },
      order() { return q; },
      insert(payload) { state.insert = payload; return q; },
      delete() { return q; },
      maybeSingle() { return q; },
      then(resolve, reject) {
        const data = state.insert ? { id: '30000000-0000-4000-8000-000000000001', ...state.insert } : null;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  postgres.db.from = chain;
  try {
    await withSql(() => ({ rows: [] }), async () => {
      const res = makeRes();
      await barbers.register({
        employeeManagement: { companyId: COMPANY_B },
        body: { login: 'ali', password: 'secret1', name: 'Ali', branch_id: BRANCH_B1, role: 'barber' },
        headers: {},
      }, res);
      assert.equal(res.statusCode, 201);
    });
  } finally {
    postgres.db.from = original;
  }
  const lookup = calls.find((c) => c.table === 'users' && !c.insert && c.eq.some(([col]) => col === 'login'));
  assert.deepEqual(lookup.eq, [['company_id', COMPANY_B], ['login', 'ali']]);
  const userInsert = calls.find((c) => c.table === 'users' && c.insert);
  assert.equal(userInsert.insert.company_id, COMPANY_B);
  const barberInsert = calls.find((c) => c.table === 'barbers' && c.insert);
  assert.equal(barberInsert.insert.company_id, COMPANY_B);
});

test('register: without a company scope nothing is created', async () => {
  const res = makeRes();
  await barbers.register({ body: { login: 'ali', password: 'secret1', name: 'Ali', branch_id: BRANCH_B1 }, headers: {} }, res);
  assert.equal(res.statusCode, 403);
});

// --------------------------------------------------------------------- jobs

test('autoClose: branches/companies are grouped by their own timezone', () => {
  const groups = groupTargetsByTimezone({
    branches: [
      { id: BRANCH_A1, timezone: null, company_timezone: 'Asia/Tashkent' },
      { id: BRANCH_B1, timezone: null, company_timezone: 'Europe/Moscow' },
      { id: 'b-override', timezone: 'Asia/Almaty', company_timezone: 'Europe/Moscow' },
    ],
    companies: [{ id: COMPANY_A, timezone: 'Asia/Tashkent' }, { id: COMPANY_B, timezone: 'Europe/Moscow' }],
  });
  assert.deepEqual(groups.get('Asia/Tashkent'), { branchIds: [BRANCH_A1], companyIds: [COMPANY_A] });
  assert.deepEqual(groups.get('Europe/Moscow'), { branchIds: [BRANCH_B1], companyIds: [COMPANY_B] });
  assert.deepEqual(groups.get('Asia/Almaty'), { branchIds: ['b-override'], companyIds: [] });
});

test('autoClose: each timezone closes at its own local midnight', async () => {
  const now = new Date('2026-11-18T20:30:00Z'); // 01:30 in Tashkent (+5), 23:30 in Moscow (+3)
  await withSql(() => ({ rows: [] }), async (seen) => {
    const result = await closePreviousDayOpenQueueEntries({
      now,
      timeZone: 'Asia/Tashkent',
      loadTargets: async () => ({
        branches: [{ id: BRANCH_A1, company_timezone: 'Asia/Tashkent' }, { id: BRANCH_B1, company_timezone: 'Europe/Moscow' }],
        companies: [],
      }),
    });
    const updates = seen.filter((q) => /update queue_entries/.test(q.sql));
    assert.equal(updates.length, 2);
    const byBranch = Object.fromEntries(updates.map((q) => [q.params[3][0], q.params[1]]));
    assert.equal(byBranch[BRANCH_A1], '2026-11-18T19:00:00.000Z'); // Tashkent midnight of the 19th
    assert.equal(byBranch[BRANCH_B1], '2026-11-17T21:00:00.000Z'); // Moscow midnight of the 18th
    assert.equal(result.status, 'ok');
  });
});

test('queue transfers: the target barber must belong to the branch company', () => {
  const source = read('src/models/queueTransfers.js');
  assert.match(source, /u\.company_id = \(select br\.company_id from branches br where br\.id = \$2\)/);
  assert.equal((source.match(/\$\{SAME_COMPANY_AS_BRANCH\}/g) || []).length, 2);
});
