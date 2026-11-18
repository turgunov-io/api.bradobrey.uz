const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PGDATABASE ||= 'cashback-settlements-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'cashback-settlements-tests';

const { createCashbackSettlements } = require('../src/models/cashbackSettlements');

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';
const SETTLEMENT_ID = '33333333-3333-4333-8333-333333333333';

// DB-loaded actors (what createAdminAuth returns); the token role never matters.
const NETWORK = { id: 'n1', sub: 'n1', role: 'admin', branch_id: null };
const BRANCH_ADMIN = { id: 'b1', sub: 'b1', role: 'admin_branch', branch_id: BRANCH_A };
const MERCHANT = { id: 'm1', sub: 'm1', role: 'merchant', branch_id: null };
const SCOPES = { n1: null, b1: [BRANCH_A], m1: [BRANCH_A] };

function makePool({ row = null } = {}) {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/for update/.test(sql)) return { rows: row ? [row] : [] };
      if (/^\s*update/.test(sql)) return { rows: [{ ...row, status: params[1] }] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    queries,
    async query(sql, params) { queries.push({ sql, params }); return { rows: [] }; },
    async connect() { return client; },
  };
}

function makeModel(actor, pool = makePool()) {
  const model = createCashbackSettlements({
    authorize: async () => actor,
    resolveScope: async (user) => SCOPES[user.id],
    pool,
  });
  return { model, pool };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

const listSql = (pool) => pool.queries.find((q) => /from cashback_settlements s/.test(q.sql));

test('list: network roles are unrestricted (optional branch filter only)', async () => {
  const { model, pool } = makeModel(NETWORK);
  const res = makeRes();
  await model.list({ query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(listSql(pool).sql, /s\.branch_id(::text)?\s*=/);

  const filtered = makeModel(NETWORK);
  await filtered.model.list({ query: { branch_id: BRANCH_B }, headers: {} }, makeRes());
  assert.deepEqual(listSql(filtered.pool).params.slice(0, 1), [BRANCH_B]);
});

test('list: branch-scoped roles (incl. merchant) are limited to their DB allowed branches', async () => {
  for (const actor of [BRANCH_ADMIN, MERCHANT]) {
    const denied = makeModel(actor);
    const res = makeRes();
    await denied.model.list({ query: { branch_id: BRANCH_B }, headers: {} }, res);
    assert.equal(res.statusCode, 403, actor.role);
    assert.equal(listSql(denied.pool), undefined);

    const unscoped = makeModel(actor);
    await unscoped.model.list({ query: {}, headers: {} }, makeRes());
    const query = listSql(unscoped.pool);
    assert.match(query.sql, /s\.branch_id::text = any\(\$1::text\[\]\)/);
    assert.deepEqual(query.params[0], [BRANCH_A]);
  }
});

test('process: a settlement outside the allowed branches is 403 and rolled back', async () => {
  const pool = makePool({ row: { id: SETTLEMENT_ID, branch_id: BRANCH_B, status: 'PENDING', metadata: {} } });
  const { model } = makeModel(MERCHANT, pool);
  const res = makeRes();
  await model.process({ params: { id: SETTLEMENT_ID }, body: { status: 'SETTLED' }, headers: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.ok(pool.queries.some((q) => q.sql === 'rollback'));
  assert.ok(!pool.queries.some((q) => /^\s*update/.test(q.sql)));
});

test('process: an in-scope settlement is processed with the DB role recorded', async () => {
  const pool = makePool({ row: { id: SETTLEMENT_ID, branch_id: BRANCH_A, status: 'PENDING', metadata: {} } });
  const { model } = makeModel(BRANCH_ADMIN, pool);
  const res = makeRes();
  await model.process({ params: { id: SETTLEMENT_ID }, body: { status: 'SETTLED' }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  const update = pool.queries.find((q) => /^\s*update/.test(q.sql));
  assert.equal(JSON.parse(update.params[3]).processed_by_role, 'admin_branch');
});

test('an unauthorized caller stops before any query', async () => {
  const pool = makePool();
  const model = createCashbackSettlements({
    authorize: async (_req, res) => { res.status(403).json({ error: 'no' }); return null; },
    resolveScope: async () => null,
    pool,
  });
  const res = makeRes();
  await model.list({ query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(pool.queries.length, 0);
});
