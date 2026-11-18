// MULTI_TENANCY B2: penalties are filtered by company, not by a branch list,
// so network admins also see their company's rows with branch_id NULL.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'company-penalties-scope-secret';

const postgres = require('../src/config/postgres');
const penalties = require('../src/models/penalties');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const ADMIN_B = '20000000-0000-4000-8000-00000000000b';
const MANAGER_B = '30000000-0000-4000-8000-00000000000b';

const bearer = (claims) => ({ authorization: `Bearer ${jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '1h' })}` });
const makeRes = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

async function withUserAndSql(user, handler, fn) {
  const originalFrom = postgres.db.from;
  const originalQuery = postgres.pool.query;
  const chain = (data) => ({
    select() { return this; }, eq() { return this; }, maybeSingle() { return this; },
    then(resolve, reject) { return Promise.resolve({ data, error: null }).then(resolve, reject); },
  });
  postgres.db.from = (table) => (table === 'users' ? chain(user) : chain([]));
  const seen = [];
  postgres.pool.query = async (sql, params = []) => {
    seen.push({ sql: String(sql), params });
    return (await handler(String(sql), params)) || { rows: [] };
  };
  try {
    return await fn(seen);
  } finally {
    postgres.db.from = originalFrom;
    postgres.pool.query = originalQuery;
  }
}

const branchesOf = (sql) => (/select id from branches where company_id/.test(sql) ? { rows: [{ id: BRANCH_B1 }] } : null);

test('penalties list: network admin is bound to the company, branch NULL rows stay visible', async () => {
  const user = { id: ADMIN_B, role: 'admin_network', branch_id: null, company_id: COMPANY_B };
  await withUserAndSql(user, (sql) => branchesOf(sql), async (seen) => {
    const res = makeRes();
    await penalties.list({ headers: bearer({ sub: ADMIN_B, role: 'admin_network' }), query: {} }, res);
    assert.equal(res.statusCode, 200);
    const manual = seen.find((q) => /from warehouse_purchases p/.test(q.sql));
    assert.match(manual.sql, /p\.company_id = \$2/);
    assert.equal(manual.params[1], COMPANY_B);
    assert.doesNotMatch(manual.sql, /p\.branch_id::text = any/);
    const late = seen.find((q) => /from barber_activity_events e/.test(q.sql));
    assert.match(late.sql, /e\.company_id = \$1/);
    assert.equal(late.params[0], COMPANY_B);
    assert.doesNotMatch(late.sql, /e\.branch_id::text = any/);
  });
});

test('penalties list: branch manager stays restricted to its branches inside its company', async () => {
  const user = { id: MANAGER_B, role: 'manager', branch_id: BRANCH_B1, company_id: COMPANY_B };
  await withUserAndSql(user, (sql) => (/from employee_branch_access|from branches/.test(sql) ? { rows: [{ id: BRANCH_B1, branch_id: BRANCH_B1 }] } : null), async (seen) => {
    const res = makeRes();
    await penalties.list({ headers: bearer({ sub: MANAGER_B, role: 'manager', branchId: BRANCH_B1 }), query: {} }, res);
    assert.equal(res.statusCode, 200);
    const manual = seen.find((q) => /from warehouse_purchases p/.test(q.sql));
    assert.match(manual.sql, /p\.company_id = \$2/);
    assert.match(manual.sql, /p\.branch_id::text = any/);
  });
});

test('penalties: user without company gets 403 COMPANY_REQUIRED', async () => {
  const user = { id: ADMIN_B, role: 'admin_network', branch_id: null, company_id: null };
  await withUserAndSql(user, () => null, async () => {
    const res = makeRes();
    await penalties.list({ headers: bearer({ sub: ADMIN_B, role: 'admin_network' }), query: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'COMPANY_REQUIRED');
  });
});

test('penalties cancel: company B admin cannot cancel a company A penalty (manual or late)', async () => {
  const user = { id: ADMIN_B, role: 'admin', branch_id: null, company_id: COMPANY_B };
  // The DB only returns rows matching the company filter; company A rows are never returned.
  await withUserAndSql(user, (sql, params) => {
    const hit = branchesOf(sql);
    if (hit) return hit;
    if (/from warehouse_purchases/.test(sql) && /company_id = \$3/.test(sql) && params[2] === COMPANY_A) {
      return { rows: [{ id: 'pen-a', branch_id: BRANCH_A1, status: 'received', metadata: {} }] };
    }
    return { rows: [] };
  }, async (seen) => {
    const res = makeRes();
    await penalties.cancel({ headers: bearer({ sub: ADMIN_B, role: 'admin' }), params: { id: 'pen-a' }, query: {} }, res);
    assert.equal(res.statusCode, 404);
    const manual = seen.find((q) => /from warehouse_purchases/.test(q.sql));
    assert.match(manual.sql, /company_id = \$3/);
    assert.equal(manual.params[2], COMPANY_B);
    const late = seen.find((q) => /from barber_activity_events e/.test(q.sql));
    assert.match(late.sql, /e\.company_id = \$2/);
    assert.equal(seen.some((q) => /^\s*update /i.test(q.sql)), false);
  });
});

test('penalties cancel: network admin may cancel its company row with branch NULL', async () => {
  const user = { id: ADMIN_B, role: 'admin_network', branch_id: null, company_id: COMPANY_B };
  await withUserAndSql(user, (sql) => {
    const hit = branchesOf(sql);
    if (hit) return hit;
    if (/from warehouse_purchases\s+where id = \$1/.test(sql)) return { rows: [{ id: 'pen-b', branch_id: null, status: 'received', metadata: {} }] };
    if (/from warehouse_purchases p/.test(sql)) return { rows: [{ id: 'pen-b', branch_id: null, status: 'cancelled', metadata: { canceled: true } }] };
    return { rows: [] };
  }, async (seen) => {
    const res = makeRes();
    await penalties.cancel({ headers: bearer({ sub: ADMIN_B, role: 'admin_network' }), params: { id: 'pen-b' }, query: {} }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const update = seen.find((q) => /update warehouse_purchases/.test(q.sql));
    assert.match(update.sql, /company_id = \$4/);
    assert.equal(update.params[3], COMPANY_B);
  });
});

test('penalties create: company is written explicitly', async () => {
  const user = { id: ADMIN_B, role: 'admin', branch_id: null, company_id: COMPANY_B };
  await withUserAndSql(user, (sql) => {
    const hit = branchesOf(sql);
    if (hit) return hit;
    if (/from barbers where id = \$1/.test(sql)) return { rows: [{ id: 'barber-b', name: 'B', branch_id: BRANCH_B1 }] };
    if (/insert into warehouse_purchases/.test(sql)) return { rows: [{ id: 'pen-new' }] };
    if (/from warehouse_purchases p/.test(sql)) return { rows: [{ id: 'pen-new', branch_id: BRANCH_B1, metadata: {} }] };
    return { rows: [] };
  }, async (seen) => {
    const res = makeRes();
    await penalties.create({ headers: bearer({ sub: ADMIN_B, role: 'admin' }), body: { branch_id: BRANCH_B1, recipient_id: 'barber-b', amount: 1000 } }, res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const insert = seen.find((q) => /insert into warehouse_purchases/.test(q.sql));
    assert.match(insert.sql, /company_id/);
    assert.ok(insert.params.includes(COMPANY_B));
    const recipient = seen.find((q) => /from barbers where id = \$1/.test(q.sql));
    assert.match(recipient.sql, /company_id = \$3/);
  });
});
