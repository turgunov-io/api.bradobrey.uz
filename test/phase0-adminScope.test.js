// Phase 0.4 / 0.5 / 0.6 branch scoping (MULTI_TENANCY.md section 2).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'phase0-scope-secret';

const postgres = require('../src/config/postgres');
const services = require('../src/models/services');
const finance = require('../src/models/finance');
const expenses = require('../src/models/expenses');
const penalties = require('../src/models/penalties');
const kioskAds = require('../src/models/kioskAds');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRANCH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SERVICE_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = 'cccccccc-0000-4000-8000-00000000000c';

function recorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

// Minimal stand-in for the db.from() query builder: every chain resolves to
// the result chosen by `respond({ table, op, filters })`.
function fakeFrom(respond) {
  return (table) => {
    const state = { table, op: 'select', filters: [], payload: null };
    const builder = {
      select() { return builder; },
      insert(payload) { state.op = 'insert'; state.payload = payload; return builder; },
      update(payload) { state.op = 'update'; state.payload = payload; return builder; },
      upsert(payload) { state.op = 'upsert'; state.payload = payload; return builder; },
      delete() { state.op = 'delete'; return builder; },
      eq(column, value) { state.filters.push([column, value]); return builder; },
      in(column, value) { state.filters.push([column, value]); return builder; },
      order() { return builder; },
      range() { return builder; },
      maybeSingle() { state.single = true; return builder; },
      then(resolve, reject) { return Promise.resolve(respond(state)).then(resolve, reject); },
    };
    return builder;
  };
}

function withDb({ from, query }, fn) {
  const original = { from: postgres.db.from, query: postgres.db.query, poolQuery: postgres.pool.query };
  if (from) postgres.db.from = from;
  if (query) { postgres.db.query = query; postgres.pool.query = query; }
  return Promise.resolve().then(fn).finally(() => {
    postgres.db.from = original.from;
    postgres.db.query = original.query;
    postgres.pool.query = original.poolQuery;
  });
}

const tokenFor = (payload) => `Bearer ${jwt.sign({ sub: USER_ID, ...payload }, process.env.JWT_SECRET)}`;

// ---------------------------------------------------------------- 0.4 services
// B2a: services are company-scoped; branch/barbershop lookups answer the tenant company.
const TENANT = { companyId: COMPANY_ID, isPlatformOwner: false };
const companyFrom = (respond) => fakeFrom((state) => (['branches', 'marketplace_barbershops'].includes(state.table)
  ? { data: { id: 'x', company_id: COMPANY_ID }, error: null }
  : respond(state)));


const SERVICES = [
  { id: 's-a', name: 'A', branch_id: BRANCH_A, is_active: true },
  { id: 's-b', name: 'B', branch_id: BRANCH_B, is_active: true },
  { id: 's-shared', name: 'Shared', branch_id: null, is_active: true },
];

test('services list: branch roles see only their branches plus shared services', async () => {
  await withDb({ from: companyFrom(() => ({ data: SERVICES, error: null })) }, async () => {
    const res = recorder();
    await services.list({ query: {}, headers: {}, tenant: TENANT, branchScope: [BRANCH_A], staffAccess: {} }, res);
    assert.deepEqual(res.body.data.map((item) => item.id).sort(), ['s-a', 's-shared']);
  });
});

test('services list: network roles keep the whole catalogue', async () => {
  await withDb({ from: companyFrom(() => ({ data: SERVICES, error: null })) }, async () => {
    const res = recorder();
    await services.list({ query: {}, headers: {}, tenant: TENANT, branchScope: null, staffAccess: {} }, res);
    assert.equal(res.body.data.length, 3);
  });
});

test('services list fails closed when a guarded request has no resolved scope', async () => {
  await withDb({ from: companyFrom(() => ({ data: SERVICES, error: null })) }, async () => {
    const res = recorder();
    await services.list({ query: {}, headers: {}, tenant: TENANT, staffAccess: { role: 'barber' } }, res);
    assert.deepEqual(res.body.data.map((item) => item.id), ['s-shared']);
  });
});

test('services getById hides services of other branches', async () => {
  const respond = () => ({ data: { id: SERVICE_ID, branch_id: BRANCH_B }, error: null });
  await withDb({ from: companyFrom(respond) }, async () => {
    const res = recorder();
    await services.getById({ params: { id: SERVICE_ID }, headers: {}, tenant: TENANT, branchScope: [BRANCH_A] }, res);
    assert.equal(res.statusCode, 404);
  });
});

test('services update/remove: branch roles cannot touch other branches or shared services', async () => {
  for (const existingBranch of [BRANCH_B, null]) {
    const writes = [];
    const respond = (state) => {
      if (state.op !== 'select') writes.push(state.op);
      return { data: { id: SERVICE_ID, branch_id: existingBranch }, error: null };
    };
    await withDb({ from: companyFrom(respond) }, async () => {
      const update = recorder();
      await services.update({ params: { id: SERVICE_ID }, body: { name: 'X' }, headers: {}, tenant: TENANT, branchScope: [BRANCH_A] }, update);
      assert.equal(update.statusCode, 403);

      const remove = recorder();
      await services.remove({ params: { id: SERVICE_ID }, body: {}, query: {}, headers: {}, tenant: TENANT, branchScope: [BRANCH_A] }, remove);
      assert.equal(remove.statusCode, 403);
    });
    assert.deepEqual(writes, []);
  }
});

test('services update: branch roles cannot move a service out of scope', async () => {
  const respond = () => ({ data: { id: SERVICE_ID, branch_id: BRANCH_A }, error: null });
  await withDb({ from: companyFrom(respond) }, async () => {
    for (const branch_id of [BRANCH_B, null]) {
      const res = recorder();
      await services.update({ params: { id: SERVICE_ID }, body: { branch_id }, headers: {}, tenant: TENANT, branchScope: [BRANCH_A] }, res);
      assert.equal(res.statusCode, 403);
    }
  });
});

test('services create: branch roles default to their home branch and cannot create shared services', async () => {
  const inserts = [];
  const respond = (state) => {
    if (state.op === 'insert') inserts.push(state.payload);
    return { data: { id: SERVICE_ID, ...state.payload }, error: null };
  };
  await withDb({ from: companyFrom(respond) }, async () => {
    const created = recorder();
    await services.create({
      body: { name: 'Cut', duration_minutes: 30 },
      headers: {}, tenant: TENANT,
      branchScope: [BRANCH_A],
      staffAccess: { actor: { id: USER_ID, branch_id: BRANCH_A } },
    }, created);
    assert.equal(created.statusCode, 201);
    assert.equal(inserts[0].branch_id, BRANCH_A);

    const foreign = recorder();
    await services.create({
      body: { name: 'Cut', duration_minutes: 30, branch_id: BRANCH_B },
      headers: {}, tenant: TENANT,
      branchScope: [BRANCH_A],
      staffAccess: { actor: { id: USER_ID, branch_id: BRANCH_A } },
    }, foreign);
    assert.equal(foreign.statusCode, 403);

    const shared = recorder();
    await services.create({
      body: { name: 'Cut', duration_minutes: 30 },
      headers: {}, tenant: TENANT,
      branchScope: [BRANCH_A],
      staffAccess: { actor: { id: USER_ID, branch_id: null } },
    }, shared);
    assert.equal(shared.statusCode, 422);
  });
  assert.equal(inserts.length, 1);
});

test('services create/update: only network roles may set marketplace_barbershop_id', async () => {
  const MP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const writes = [];
  const respond = (state) => {
    if (state.op === 'insert' || state.op === 'update') writes.push({ op: state.op, payload: state.payload });
    return { data: { id: SERVICE_ID, branch_id: BRANCH_A, ...(state.payload || {}) }, error: null };
  };
  await withDb({ from: companyFrom(respond) }, async () => {
    const branchCreate = recorder();
    await services.create({
      body: { name: 'Cut', duration_minutes: 30, branch_id: BRANCH_A, marketplace_barbershop_id: MP_ID },
      headers: {}, tenant: TENANT,
      branchScope: [BRANCH_A],
      staffAccess: { actor: { id: USER_ID, branch_id: BRANCH_A } },
    }, branchCreate);
    assert.equal(branchCreate.statusCode, 201);

    const branchUpdate = recorder();
    await services.update({
      params: { id: SERVICE_ID }, body: { name: 'X', marketplace_barbershop_id: MP_ID }, headers: {}, tenant: TENANT, branchScope: [BRANCH_A],
    }, branchUpdate);
    assert.equal(branchUpdate.statusCode, 200);

    const networkCreate = recorder();
    await services.create({
      body: { name: 'Cut', duration_minutes: 30, marketplace_barbershop_id: MP_ID }, headers: {}, tenant: TENANT, branchScope: null, staffAccess: {},
    }, networkCreate);
    const networkUpdate = recorder();
    await services.update({
      params: { id: SERVICE_ID }, body: { marketplace_barbershop_id: MP_ID }, headers: {}, tenant: TENANT, branchScope: null,
    }, networkUpdate);
  });
  const [branchInsert, branchPatch, networkInsert, networkPatch] = writes;
  assert.equal(branchInsert.payload.marketplace_barbershop_id ?? null, null);
  assert.equal('marketplace_barbershop_id' in branchPatch.payload, false);
  assert.equal(networkInsert.payload.marketplace_barbershop_id, MP_ID);
  assert.equal(networkPatch.payload.marketplace_barbershop_id, MP_ID);
});

test('services reorder: branch roles cannot reorder services outside their scope', async () => {
  const query = async () => ({ rows: [{ id: SERVICE_ID, branch_id: null }] });
  await withDb({ query }, async () => {
    const res = recorder();
    await services.reorder({
      body: { items: [{ id: SERVICE_ID, sort_order: 1, category: null }] }, tenant: TENANT,
      branchScope: [BRANCH_A],
    }, res);
    assert.equal(res.statusCode, 403);
  });
});

// ----------------------------------------------------------------- 0.5 finance

test('finance overview: requested branch outside scope is forbidden', async () => {
  let queried = false;
  await withDb({ query: async () => { queried = true; return { rows: [] }; } }, async () => {
    const res = recorder();
    await finance.overview({ query: { branch_id: BRANCH_B }, branchScope: [BRANCH_A] }, res);
    assert.equal(res.statusCode, 403);
  });
  assert.equal(queried, false);
});

test('finance overview: without a branch, only allowed branches are aggregated', async () => {
  const calls = [];
  await withDb({ query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } }, async () => {
    const res = recorder();
    await finance.overview({ query: {}, branchScope: [BRANCH_A], tenant: TENANT }, res);
    assert.equal(res.statusCode, 200);
  });
  assert.equal(calls.length, 4);
  for (const { sql, params } of calls) {
    assert.match(sql, /::text\[\] is null or/);
    // MULTI_TENANCY B2: [..., branchFilter, companyId]
    assert.deepEqual(params.at(-2), [BRANCH_A]);
    assert.equal(params.at(-1), COMPANY_ID);
  }
});

test('finance overview: network roles stay network-wide', async () => {
  const calls = [];
  await withDb({ query: async (sql, params) => { calls.push(params); return { rows: [] }; } }, async () => {
    const res = recorder();
    await finance.overview({ query: { branch_id: BRANCH_B }, branchScope: null, tenant: TENANT }, res);
    assert.equal(res.statusCode, 200);
  });
  // Network-wide within the company: no branch filter, company filter always.
  for (const params of calls) {
    assert.equal(params.at(-2), null);
    assert.equal(params.at(-1), COMPANY_ID);
  }
});

test('finance snapshot: branch outside scope is forbidden', async () => {
  const res = recorder();
  await finance.get({ query: { branch_id: BRANCH_B }, branchScope: [BRANCH_A] }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(finance.resolveBranchFilter({ branchScope: [BRANCH_A] }, BRANCH_A), { branchFilter: [BRANCH_A] });
});

// --------------------------------------------------- 0.6 expenses / penalties

function staffDb({ role, allowed = [BRANCH_A] }) {
  const queries = [];
  const from = fakeFrom((state) => {
    if (state.table === 'users') return { data: { id: USER_ID, role, branch_id: BRANCH_A, company_id: COMPANY_ID }, error: null };
    return { data: [], error: null };
  });
  const query = async (sql, params) => {
    queries.push({ sql, params });
    if (/from branches b/i.test(sql)) return { rows: allowed.map((id) => ({ id })) };
    if (/from branches where company_id/i.test(sql)) return { rows: [{ id: BRANCH_A }, { id: BRANCH_B }] };
    return { rows: [] };
  };
  return { from, query, queries };
}

for (const [name, model] of [['expenses', expenses], ['penalties', penalties]]) {
  test(`${name}: admin_branch with a network role in its token is scoped by its DB role`, async () => {
    const stub = staffDb({ role: 'admin_branch' });
    await withDb(stub, async () => {
      const res = recorder();
      await model.list({ headers: { authorization: tokenFor({ role: 'admin_network' }) }, query: {} }, res);
      assert.equal(res.statusCode, 200);
    });
    const listQuery = stub.queries.find(({ sql }) => /warehouse_purchases/.test(sql));
    assert.match(listQuery.sql, /p\.branch_id::text = any\(/);
    assert.ok(listQuery.params.some((value) => Array.isArray(value) && value.includes(BRANCH_A)));
  });

  test(`${name}: admin_branch cannot request another branch`, async () => {
    const stub = staffDb({ role: 'admin_branch' });
    await withDb(stub, async () => {
      const res = recorder();
      await model.list({ headers: { authorization: tokenFor({ role: 'admin_branch' }) }, query: { branch_id: BRANCH_B } }, res);
      assert.equal(res.statusCode, 403);
    });
  });

  test(`${name}: network roles see every branch of their own company only`, async () => {
    const stub = staffDb({ role: 'admin' });
    await withDb(stub, async () => {
      const res = recorder();
      await model.list({ headers: { authorization: tokenFor({ role: 'admin' }) }, query: {} }, res);
      assert.equal(res.statusCode, 200);
    });
    const companyQuery = stub.queries.find(({ sql }) => /from branches where company_id/.test(sql));
    assert.deepEqual(companyQuery.params, [COMPANY_ID]);
    const listQuery = stub.queries.find(({ sql }) => /warehouse_purchases/.test(sql));
    if (name === 'expenses' || name === 'penalties') {
      // MULTI_TENANCY B2: company filter instead of a branch allow-list, so
      // company-level rows (branch_id NULL) stay visible to network admins.
      assert.match(listQuery.sql, /p\.company_id = \$2/);
      assert.equal(listQuery.params[1], COMPANY_ID);
      assert.doesNotMatch(listQuery.sql, /branch_id::text = any/);
    } else {
      assert.match(listQuery.sql, /branch_id::text = any/);
      assert.ok(listQuery.params.some((value) => Array.isArray(value) && value.includes(BRANCH_A) && value.includes(BRANCH_B)));
    }
  });
}

test('penalties: admin_branch cannot create a penalty in another branch', async () => {
  const stub = staffDb({ role: 'admin_branch' });
  await withDb(stub, async () => {
    const res = recorder();
    await penalties.create({
      headers: { authorization: tokenFor({ role: 'admin_branch' }) },
      body: { branch_id: BRANCH_B, recipient_id: USER_ID, amount: 100 },
    }, res);
    assert.equal(res.statusCode, 403);
  });
  assert.ok(!stub.queries.some(({ sql }) => /insert into warehouse_purchases/.test(sql)));
});

// --------------------------------------------------------------- 0.6 verifix

function loadVerifix(respond) {
  const calls = [];
  const query = async (sql, params) => { calls.push({ sql: sql.trim(), params }); return { rows: [], rowCount: 0 }; };
  const context = { module: { exports: {} }, process: { env: {} }, require(name) {
    if (name === '../utils/authToken') return { verifyAny: () => ({ sub: USER_ID, role: 'admin_network', branchId: BRANCH_A }) };
    if (name.includes('postgres')) return { db: { query, from: fakeFrom((state) => { calls.push(state); return respond(state); }) }, pool: { connect: async () => ({ query, release() {} }) } };
    throw new Error(name);
  }};
  vm.runInNewContext(fs.readFileSync('src/models/verifix.js', 'utf8'), context);
  return { api: context.module.exports, calls };
}

const verifixReq = (extra) => ({
  headers: { authorization: 'Bearer test' },
  query: {},
  body: {},
  dbActor: { id: USER_ID, role: 'admin_branch', branchScope: [BRANCH_A], sessionBranchId: BRANCH_A },
  ...extra,
});

test('verifix: DB role overrides the token role and limits events to allowed branches', async () => {
  const { api, calls } = loadVerifix(() => ({ data: [], error: null, count: 0 }));
  const res = recorder();
  await api.listEvents(verifixReq(), res);
  assert.equal(res.statusCode, 200);
  const state = calls.find((call) => call.table === 'barber_activity_events');
  assert.deepEqual(state.filters, [['branch_id', [BRANCH_A]]]);

  const foreign = recorder();
  await api.listEvents(verifixReq({ query: { branch_id: BRANCH_B } }), foreign);
  assert.equal(foreign.statusCode, 403);
});

test('verifix: schedules are scoped for admin_branch', async () => {
  const { api } = loadVerifix((state) => ({
    data: state.table === 'barber_work_schedules' ? { id: 'x', branch_id: BRANCH_B, start_time: '10:00', end_time: '20:00' } : null,
    error: null,
  }));
  const list = recorder();
  await api.listSchedules(verifixReq({ query: { branch_id: BRANCH_B } }), list);
  assert.equal(list.statusCode, 403);

  const create = recorder();
  await api.createSchedule(verifixReq({ body: { branch_id: BRANCH_B, day_of_week: 1, start_time: '10:00', end_time: '20:00' } }), create);
  assert.equal(create.statusCode, 403);

  const update = recorder();
  await api.updateSchedule(verifixReq({ params: { id: 'x' }, body: { grace_minutes: 5 } }), update);
  assert.equal(update.statusCode, 404);

  const remove = recorder();
  await api.deleteSchedule(verifixReq({ params: { id: 'x' } }), remove);
  assert.equal(remove.statusCode, 404);

  const bulk = recorder();
  await api.bulkSchedules(verifixReq({ body: { branch_ids: [BRANCH_B], start_time: '10:00', end_time: '20:00', grace_minutes: 0 } }), bulk);
  assert.equal(bulk.statusCode, 403);
});

test('verifix: network roles from the DB keep unfiltered event access', async () => {
  const { api, calls } = loadVerifix(() => ({ data: [], error: null, count: 0 }));
  const res = recorder();
  await api.listEvents(verifixReq({ dbActor: { id: USER_ID, role: 'admin_network', branchScope: null } }), res);
  assert.equal(res.statusCode, 200);
  const state = calls.find((call) => call.table === 'barber_activity_events');
  assert.deepEqual(state.filters, []);
});

test('verifix: without a DB-loaded actor (req.dbActor) every handler fails closed with 401', async () => {
  const { api, calls } = loadVerifix(() => ({ data: [], error: null, count: 0 }));
  const noActor = (extra) => ({ ...verifixReq(extra), dbActor: undefined });
  for (const [name, req] of [
    ['listEvents', noActor()],
    ['listSchedules', noActor()],
    ['startShift', noActor({ body: { barber_id: USER_ID, branch_id: BRANCH_A } })],
    ['createSchedule', noActor({ body: { branch_id: BRANCH_A, day_of_week: 1, start_time: '10:00', end_time: '20:00' } })],
  ]) {
    const res = recorder();
    await api[name](req, res);
    assert.equal(res.statusCode, 401, name);
  }
  assert.equal(calls.length, 0);
});

test('barbers router: shift start/end load the DB actor before verifix runs', () => {
  const router = require('../src/routers/barbers');
  const { attachDbActor } = require('../src/utils/adminAuth');
  for (const path of ['/shift/start', '/shift/end']) {
    const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods.post);
    assert.ok(layer, path);
    assert.equal(layer.route.stack[0].handle, attachDbActor, path);
  }
});

// --------------------------------------------------------------- 0.6 kioskAds

function kioskAdsDb(role) {
  const writes = [];
  const from = fakeFrom((state) => {
    if (state.table === 'users') return { data: { id: USER_ID, login: 'x', role, branch_id: BRANCH_A, company_id: COMPANY_ID }, error: null };
    if (state.table === 'companies') return { data: { id: COMPANY_ID, status: 'active' }, error: null };
    if (state.table === 'barbers') return { data: null, error: null };
    if (state.op !== 'select') writes.push(state);
    return { data: { id: 1, regular_urls: [], kids_urls: [] }, error: null };
  });
  return { from, writes };
}

test('kiosk ads: branch-level admins can read but not change the network singleton', async () => {
  for (const role of ['admin_branch', 'merchant']) {
    const stub = kioskAdsDb(role);
    await withDb(stub, async () => {
      const read = recorder();
      await kioskAds.getSettings({ headers: { authorization: tokenFor({ role: 'admin_network' }) } }, read);
      assert.equal(read.statusCode, 200);

      const write = recorder();
      await kioskAds.updateSettings({
        headers: { authorization: tokenFor({ role: 'admin_network' }) },
        body: { regular_urls: ['https://youtu.be/abc'] },
      }, write);
      assert.equal(write.statusCode, 403);
    });
    assert.deepEqual(stub.writes, []);
  }
});

test('kiosk ads: network admins can change settings; token role alone is not enough', async () => {
  const admin = kioskAdsDb('admin_network');
  await withDb(admin, async () => {
    const res = recorder();
    await kioskAds.updateSettings({
      headers: { authorization: tokenFor({ role: 'barber' }) },
      body: { regular_urls: ['https://youtu.be/abc'] },
    }, res);
    assert.equal(res.statusCode, 200);
  });
  assert.equal(admin.writes.length, 1);

  const barber = kioskAdsDb('barber');
  await withDb(barber, async () => {
    const res = recorder();
    await kioskAds.getSettings({ headers: { authorization: tokenFor({ role: 'admin_network' }) } }, res);
    assert.equal(res.statusCode, 403);
  });
});
