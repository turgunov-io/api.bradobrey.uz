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
const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const NETWORK = { id: 'n1', sub: 'n1', role: 'admin', branch_id: null, companyId: COMPANY_A };
const NETWORK_B = { id: 'n2', sub: 'n2', role: 'admin', branch_id: null, companyId: COMPANY_B };
const BRANCH_ADMIN = { id: 'b1', sub: 'b1', role: 'admin_branch', branch_id: BRANCH_A, companyId: COMPANY_A };
const MERCHANT = { id: 'm1', sub: 'm1', role: 'merchant', branch_id: null, companyId: COMPANY_A };
// Network roles get their company's branches marked company-wide (adminAuth).
const companyWide = (ids) => Object.defineProperty([...ids], 'companyWide', { value: true });
const SCOPES = { n1: companyWide([BRANCH_A]), n2: companyWide([BRANCH_B]), b1: [BRANCH_A], m1: [BRANCH_A] };

function makePool({ row = null } = {}) {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/for update/.test(sql)) {
        // Mirrors `where id = $1 and company_id = $2`.
        return { rows: row && (!row.company_id || row.company_id === params[1]) ? [row] : [] };
      }
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

test('list: network roles see their whole company (incl. branch_id NULL), never another company', async () => {
  const { model, pool } = makeModel(NETWORK);
  const res = makeRes();
  await model.list({ query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  const query = listSql(pool);
  assert.match(query.sql, /s\.company_id = \$1/);
  assert.equal(query.params[0], COMPANY_A);
  assert.doesNotMatch(query.sql, /s\.branch_id(::text)?\s*=/);

  const filtered = makeModel(NETWORK);
  await filtered.model.list({ query: { branch_id: BRANCH_A }, headers: {} }, makeRes());
  assert.deepEqual(listSql(filtered.pool).params.slice(0, 2), [COMPANY_A, BRANCH_A]);
});

test('list: company B admin cannot list company A settlements (company filter is B)', async () => {
  const { model, pool } = makeModel(NETWORK_B);
  await model.list({ query: { branch_id: BRANCH_B }, headers: {} }, makeRes());
  assert.equal(listSql(pool).params[0], COMPANY_B);
});

test('process: company B admin cannot process a company A settlement (404, no update)', async () => {
  const pool = makePool({ row: { id: SETTLEMENT_ID, branch_id: BRANCH_A, company_id: COMPANY_A, status: 'PENDING', metadata: {} } });
  const { model } = makeModel(NETWORK_B, pool);
  const res = makeRes();
  await model.process({ params: { id: SETTLEMENT_ID }, body: { status: 'SETTLED' }, headers: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.ok(!pool.queries.some((q) => /^\s*update/.test(q.sql)));
});

test('an admin without a company is refused before any query', async () => {
  const { model, pool } = makeModel({ ...NETWORK, companyId: null });
  const res = makeRes();
  await model.list({ query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(pool.queries.length, 0);
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
    assert.match(query.sql, /s\.branch_id::text = any\(\$2::text\[\]\)/);
    assert.deepEqual(query.params.slice(0, 2), [COMPANY_A, [BRANCH_A]]);
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
