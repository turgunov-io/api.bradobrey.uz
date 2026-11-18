// POST /api/barbers/login and /api/barbers/admin/login with company_code
// (MULTI_TENANCY Phase 1 step B1).
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'company-login-secret';

const postgres = require('../src/config/postgres');
const barbers = require('../src/models/barbers');

const DEFAULT_COMPANY = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PRESIDENT = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ADMIN_ID = '10000000-0000-4000-8000-00000000000a';
const PASSWORD_HASH = bcrypt.hashSync('secret-pass', 4);

const COMPANIES = [
  { id: DEFAULT_COMPANY, code: 'BRADOBREY', status: 'active', is_default: true },
  { id: PRESIDENT, code: 'PRESIDENT', status: 'active', is_default: false },
];

function recorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

// users rows live per company; logins may repeat across companies.
const USERS = [
  { id: ADMIN_ID, login: 'boss', role: 'admin', branch_id: null, company_id: PRESIDENT, password_hash: PASSWORD_HASH },
];

function fakeFrom(filtersSeen) {
  return (table) => {
    const filters = [];
    const builder = {
      select() { return builder; },
      eq(column, value) { filters.push([column, value]); return builder; },
      in() { return builder; },
      limit() { return builder; },
      maybeSingle() { builder.single = true; return builder; },
      then(resolve, reject) {
        filtersSeen.push({ table, filters });
        let rows = [];
        if (table === 'users') {
          rows = USERS.filter((user) => filters.every(([column, value]) => String(user[column]) === String(value)));
        }
        const data = builder.single ? rows[0] || null : rows;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  };
}

async function withDb(fn, { companyCount = COMPANIES.length } = {}) {
  const filtersSeen = [];
  const original = { from: postgres.db.from, poolQuery: postgres.pool.query, dbQuery: postgres.db.query };
  postgres.db.from = fakeFrom(filtersSeen);
  postgres.pool.query = async (sql, params = []) => {
    if (/count\(\*\)/.test(sql) && /from companies/.test(sql)) return { rows: [{ count: companyCount }] };
    if (/from companies/.test(sql) && /lower\(code\)/.test(sql)) {
      return { rows: COMPANIES.filter((row) => row.code.toLowerCase() === String(params[0]).toLowerCase() && row.status === 'active') };
    }
    if (/from companies/.test(sql) && /is_default/.test(sql)) return { rows: COMPANIES.filter((row) => row.is_default) };
    return { rows: [] };
  };
  postgres.db.query = postgres.pool.query;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return await fn({ filtersSeen, warnings });
  } finally {
    console.warn = originalWarn;
    postgres.db.from = original.from;
    postgres.pool.query = original.poolQuery;
    postgres.db.query = original.dbQuery;
  }
}

for (const [name, handler] of [['login', 'login'], ['admin login', 'adminLogin']]) {
  test(`${name}: company_code scopes the login lookup and puts companyId in the token`, async () => {
    await withDb(async ({ filtersSeen }) => {
      const res = recorder();
      await barbers[handler]({ body: { company_code: ' president ', login: 'boss', password: 'secret-pass' }, app: { get: () => null } }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      const claims = jwt.verify(res.body.token, process.env.JWT_SECRET);
      assert.equal(claims.companyId, PRESIDENT);
      assert.equal(res.body.user.company_id, PRESIDENT);
      const lookup = filtersSeen.find((entry) => entry.table === 'users');
      assert.deepEqual(lookup.filters[0], ['company_id', PRESIDENT]);
    });
  });

  test(`${name}: an unknown company code is 404 COMPANY_NOT_FOUND`, async () => {
    await withDb(async () => {
      const res = recorder();
      await barbers[handler]({ body: { company_code: 'NOPE', login: 'boss', password: 'secret-pass' } }, res);
      assert.equal(res.statusCode, 404);
      assert.equal(res.body.code, 'COMPANY_NOT_FOUND');
    });
  });

  test(`${name}: without company_code and 2+ companies the login is refused with COMPANY_CODE_REQUIRED`, async () => {
    await withDb(async ({ filtersSeen }) => {
      const res = recorder();
      await barbers[handler]({ body: { login: 'boss', password: 'secret-pass' } }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'COMPANY_CODE_REQUIRED');
      assert.equal(filtersSeen.filter((entry) => entry.table === 'users').length, 0, 'no user lookup');
    });
  });

  test(`${name}: without company_code the default company is used while it is the only company, with a warning`, async () => {
    await withDb(async ({ filtersSeen, warnings }) => {
      const res = recorder();
      // `boss` belongs to PRESIDENT, not the default company -> not found there.
      await barbers[handler]({ body: { login: 'boss', password: 'secret-pass' } }, res);
      assert.equal(res.statusCode, 400);
      const lookup = filtersSeen.find((entry) => entry.table === 'users');
      assert.deepEqual(lookup.filters[0], ['company_id', DEFAULT_COMPANY]);
      assert.ok(warnings.some((message) => message.includes('without company_code')));
    }, { companyCount: 1 });
  });
}
