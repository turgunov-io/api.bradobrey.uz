// Phase 2 (group B) LOW findings: company filters fail closed, branch and
// role always from the DB / validated session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'phase2-b-low-secret';

const postgres = require('../src/config/postgres');
const barbers = require('../src/models/barbers');
const { selectEmployeeBranches, listEmployeeBranches } = require('../src/utils/employeeBranches');
const { listLocationEvents } = require('../src/services/barberLocation');
const { installDbMock, makeRes, eqCalls } = require('./helpers/tenantMocks');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const USER_B = '20000000-0000-4000-8000-00000000000b';

test('barber work statistics: every source is bound to the employee company', async () => {
  const mock = installDbMock({});
  try {
    await barbers._private.getBarberWorkStatistics({ barberId: USER_B, period: '2026-11', companyId: COMPANY_B });
    for (const table of ['queue_entries', 'branches', 'barber_activity_events', 'finance_snapshots']) {
      assert.deepEqual(eqCalls(mock.calls, table, 'company_id'), [COMPANY_B], table);
    }
  } finally { mock.restore(); }
});

test('barber work statistics: no company -> empty result, no query', async () => {
  const mock = installDbMock({});
  try {
    const result = await barbers._private.getBarberWorkStatistics({ barberId: USER_B, period: '2026-11', companyId: null });
    assert.equal(result.totals.services, 0);
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
});

test('employee directory fails closed without a company', async () => {
  const mock = installDbMock({});
  try {
    await assert.rejects(() => barbers._private.loadEmployeeDirectory({ companyId: null }), { code: 'COMPANY_REQUIRED' });
    assert.equal(mock.calls.length, 0);
    const res = makeRes();
    await barbers.list({ query: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
});

test('selectEmployeeBranches: without a company nothing is selectable', () => {
  const branches = [{ id: BRANCH_A1, company_id: COMPANY_A, is_active: true }, { id: BRANCH_B1, company_id: COMPANY_B, is_active: true }];
  assert.deepEqual(selectEmployeeBranches(branches, [], { role: 'admin' }), []);
  assert.deepEqual(selectEmployeeBranches(branches, [], { role: 'admin', companyId: COMPANY_B }).map((b) => b.id), [BRANCH_B1]);
});

test('listEmployeeBranches pre-migration fallback stays inside the employee company', async () => {
  const original = postgres.db.query;
  const seen = [];
  postgres.db.query = async (sql, params) => {
    seen.push({ sql: String(sql), params });
    if (seen.length === 1) throw Object.assign(new Error('relation "employee_branch_access" does not exist'), { code: '42P01' });
    return { rows: [] };
  };
  try {
    await listEmployeeBranches(USER_B, BRANCH_A1);
  } finally { postgres.db.query = original; }
  const fallback = seen[1];
  assert.match(fallback.sql, /company_id = \(select company_id from users where id = \$2\)/);
  assert.deepEqual(fallback.params, [BRANCH_A1, USER_B]);
});

test('location admin: branch scope comes from users.branch_id, not the token claim', async () => {
  const original = postgres.db.query;
  let listParams = null;
  postgres.db.query = async (sql, params) => {
    if (/from users u\s+left join companies c/.test(sql)) {
      return { rows: [{ id: USER_B, role: 'admin_branch', branch_id: BRANCH_B1, company_id: COMPANY_B, company_status: 'active' }] };
    }
    listParams = params;
    return { rows: [] };
  };
  try {
    // Token claims another branch; DB home branch wins.
    const token = jwt.sign({ sub: USER_B, role: 'admin_branch', branchId: BRANCH_A1 }, process.env.JWT_SECRET);
    const res = makeRes();
    await listLocationEvents({ headers: { authorization: `Bearer ${token}` }, query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(listParams.slice(0, 2), [COMPANY_B, BRANCH_B1]);

    const foreign = makeRes();
    await listLocationEvents({ headers: { authorization: `Bearer ${token}` }, query: { branch_id: BRANCH_A1 } }, foreign);
    assert.equal(foreign.statusCode, 403);
  } finally { postgres.db.query = original; }
});

test('location manager: session branch only with a validated session context', async () => {
  const original = postgres.db.query;
  postgres.db.query = async (sql) => {
    if (/from users u\s+left join companies c/.test(sql)) {
      return { rows: [{ id: USER_B, role: 'manager', branch_id: BRANCH_B1, company_id: COMPANY_B, company_status: 'active' }] };
    }
    return { rows: [] };
  };
  try {
    const token = jwt.sign({ sub: USER_B, role: 'manager', branchId: BRANCH_B1, jti: 's' }, process.env.JWT_SECRET);
    const unvalidated = makeRes();
    await listLocationEvents({ headers: { authorization: `Bearer ${token}` }, query: {} }, unvalidated);
    assert.equal(unvalidated.statusCode, 403);

    const validated = makeRes();
    await listLocationEvents({
      headers: { authorization: `Bearer ${token}` },
      query: {},
      employeeAccess: { user: { id: USER_B, role: 'manager' }, sessionValid: true },
    }, validated);
    assert.equal(validated.statusCode, 200);
  } finally { postgres.db.query = original; }
});

test('socket handshake: session requirement and role follow the DB role', () => {
  const source = fs.readFileSync('src/server.js', 'utf8');
  assert.match(source, /isTokenRoleStale\(payload, state\.user\)/);
  assert.match(source, /SESSION_BOUND_ROLES\.has\(dbRole\)/);
  assert.doesNotMatch(source, /\]\.includes\(payload\.role\)/);
});
