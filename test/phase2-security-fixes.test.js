// Phase 2 security-review fixes (MULTI_TENANCY.md section 11).
//
// M1  timezones: only IANA zone names reach SQL `at time zone $n`. Postgres
//     reads '+05:00' as POSIX (UTC-5) and abbreviations by its own table, so
//     offsets/abbreviations are rejected on read (pickTimezone) and on write
//     (400 INVALID_TIMEZONE).
// M2  barbershop create is all-or-nothing: a failed branch sync leaves no
//     orphan row, so a retry is not a 409.
// L1  employeeAccess: role checks are case-insensitive (no casing bypass) and
//     the session binding follows the DB role.
// L2  only the company_id unique violation means COMPANY_BARBERSHOP_EXISTS.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'phase2-security-fixes-secret';

const tz = require('../src/utils/tenantTimezone');
const { installFakeDb } = require('./helpers/phase2aFakeDb');
const { installPoolMock, makeRes, staffReq } = require('./helpers/tenantMocks');
const barbershops = require('../src/models/marketplace/barbershops');
const branches = require('../src/models/branches');
const merchant = require('../src/models/merchant');
const { validateCompanyFields } = require('../src/models/platform');
const { createEmployeeAccessMiddleware } = require('../src/middleware/employeeAccess');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_C = 'cccccccc-0000-4000-8000-00000000000c';
const BRANCH_C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const SHOP_C = 'c5c5c5c5-0000-4000-8000-0000000000c5';

// ---------------------------------------------------------------- M1 (read)

test('M1: offsets, abbreviations and POSIX names are not valid timezones', () => {
  for (const value of ['+05:00', '-0500', '+05', 'UTC+5', 'EST', 'GMT', 'Z', 'EST5EDT', 'US/Eastern', 'Asia', '/Tashkent', 'Asia/Tashkent/', 'Nope/Nope', '', null, 42]) {
    assert.equal(tz.isValidTimeZone(value), false, JSON.stringify(value));
  }
});

test('M1: IANA Area/Location names, UTC and Etc/* are valid', () => {
  for (const value of ['Asia/Tashkent', 'Europe/Moscow', 'America/Argentina/Buenos_Aires', 'UTC', 'utc', 'Etc/GMT+5', 'Etc/UTC', 'asia/tashkent']) {
    assert.equal(tz.isValidTimeZone(value), true, value);
  }
});

test('M1: pickTimezone skips offsets and returns the canonical case', () => {
  assert.equal(tz.pickTimezone('+05:00', 'Europe/Moscow'), 'Europe/Moscow');
  assert.equal(tz.pickTimezone('EST'), tz.DEFAULT_TIMEZONE);
  assert.equal(tz.pickTimezone('asia/almaty'), 'Asia/Almaty');
  assert.equal(tz.pickTimezone(' utc '), 'UTC');
  assert.equal(tz.pickTimezone('etc/gmt+5'), 'Etc/GMT+5');
});

test('M1: resolveTimezone never hands an offset string to SQL', async () => {
  const query = async () => ({ rows: [{ timezone: '+05:00', company_timezone: 'utc' }] });
  assert.equal(await tz.resolveTimezone({ branchId: BRANCH_C1 }, { query }), 'UTC');
  assert.equal(await tz.timezoneOfBranchRow({ id: BRANCH_C1, timezone: '+05:00', company_id: COMPANY_C }, {
    query: async () => ({ rows: [{ timezone: 'Asia/Almaty' }] }),
  }), 'Asia/Almaty');
});

test('M1: normalizeTimezoneInput: undefined keeps, blank clears, invalid flags, valid canonicalises', () => {
  assert.deepEqual(tz.normalizeTimezoneInput(undefined), { value: undefined });
  assert.deepEqual(tz.normalizeTimezoneInput(null), { value: null });
  assert.deepEqual(tz.normalizeTimezoneInput('  '), { value: null });
  assert.deepEqual(tz.normalizeTimezoneInput('asia/tashkent'), { value: 'Asia/Tashkent' });
  assert.equal(tz.normalizeTimezoneInput('+05:00').error.code, 'INVALID_TIMEZONE');
  assert.equal(tz.normalizeTimezoneInput(5).error.code, 'INVALID_TIMEZONE');
});

// --------------------------------------------------------------- M1 (write)

const shopSeed = () => ({
  marketplace_barbershops: [{ id: SHOP_C, name: 'C', company_id: COMPANY_C, metadata: {}, is_active: true }],
  branches: [{ id: BRANCH_C1, company_id: COMPANY_C, marketplace_barbershop_id: SHOP_C, timezone: 'Asia/Tashkent' }],
  users: [],
});

async function callShop(method, req, fake) {
  const res = makeRes();
  try {
    await barbershops[method](req, res);
  } finally {
    fake.restore();
  }
  return res;
}

test('M1: barbershop create/update reject an invalid timezone with 400 INVALID_TIMEZONE, nothing written', async () => {
  let fake = installFakeDb({ marketplace_barbershops: [], branches: [], users: [] });
  const created = await callShop('create', staffReq(COMPANY_C, { body: { name: 'New', timezone: '+05:00' } }), fake);
  assert.equal(created.statusCode, 400);
  assert.equal(created.body.code, 'INVALID_TIMEZONE');
  assert.equal(fake.writes.length, 0);

  fake = installFakeDb(shopSeed());
  const updated = await callShop('update', staffReq(COMPANY_C, { params: { id: SHOP_C }, body: { timezone: 'EST' } }), fake);
  assert.equal(updated.statusCode, 400);
  assert.equal(updated.body.code, 'INVALID_TIMEZONE');
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.tables().branches[0].timezone, 'Asia/Tashkent', 'linked branch timezone untouched');
});

test('M1: barbershop update stores the canonical zone and copies it to linked branches', async () => {
  const fake = installFakeDb(shopSeed());
  const { tables } = fake;
  const res = await callShop('update', staffReq(COMPANY_C, { params: { id: SHOP_C }, body: { timezone: 'europe/moscow' } }), fake);
  assert.equal(res.statusCode, 200);
  assert.equal(tables().marketplace_barbershops[0].timezone, 'Europe/Moscow');
  assert.equal(tables().branches[0].timezone, 'Europe/Moscow');
});

test('M1: branches payload rejects an invalid timezone with INVALID_TIMEZONE', async () => {
  const { normalizeBranchPayload } = branches._internals;
  assert.equal(normalizeBranchPayload({ name: 'X', timezone: '+05:00' }).code, 'INVALID_TIMEZONE');
  assert.equal(normalizeBranchPayload({ name: 'X', timezone: 'asia/tashkent' }).payload.timezone, 'Asia/Tashkent');
  assert.equal(normalizeBranchPayload({ name: 'X', timezone: '' }).payload.timezone, null);

  for (const [method, extra] of [['create', {}], ['update', { params: { id: BRANCH_C1 } }]]) {
    const res = makeRes();
    await branches[method](staffReq(COMPANY_C, { body: { name: 'X', timezone: 'GMT' }, ...extra }), res);
    assert.equal(res.statusCode, 400, method);
    assert.equal(res.body.code, 'INVALID_TIMEZONE', method);
  }
});

test('M1: merchant createBranch/updateBranch reject an invalid timezone before any write', async () => {
  const MERCHANT = '20000000-0000-4000-8000-00000000000c';
  const headers = { authorization: `Bearer ${jwt.sign({ sub: MERCHANT, role: 'merchant' }, process.env.JWT_SECRET)}` };
  const mock = installPoolMock((sql) => {
    if (/from users u\s+left join companies c/.test(sql)) {
      return { rows: [{ id: MERCHANT, login: 'm', role: 'merchant', branch_id: null, marketplace_barbershop_id: SHOP_C, company_id: COMPANY_C, company_status: 'active' }] };
    }
    if (/from marketplace_barbershops where id = \$1 and company_id = \$2/.test(sql)) return { rows: [{}] };
    return { rows: [] };
  });
  try {
    for (const [method, extra] of [['createBranch', {}], ['updateBranch', { params: { id: BRANCH_C1 } }]]) {
      const res = makeRes();
      await merchant[method]({ headers, params: {}, query: {}, body: { name: 'X', timezone: '+05:00' }, ...extra }, res);
      assert.equal(res.statusCode, 400, method);
      assert.equal(res.body.code, 'INVALID_TIMEZONE', method);
    }
  } finally {
    mock.restore();
  }
  assert.ok(!mock.calls.some((call) => /^\s*(insert|update)\b/i.test(call.sql)), 'nothing written');
});

test('M1: platform company fields accept only IANA names (canonical case)', () => {
  assert.match(validateCompanyFields({ name: 'X', code: 'xx', timezone: '+05:00' }).error, /IANA/);
  assert.match(validateCompanyFields({ timezone: 'EST' }, { partial: true }).error, /IANA/);
  assert.equal(validateCompanyFields({ timezone: 'asia/tashkent' }, { partial: true }).fields.timezone, 'Asia/Tashkent');
});

// ----------------------------------------------------------------------- M2

test('M2: create rolls back the new barbershop when the branch sync fails; a retry succeeds', async () => {
  const seed = { marketplace_barbershops: [], branches: [{ id: BRANCH_C1, company_id: COMPANY_C, marketplace_barbershop_id: null }], users: [] };
  let failing = true;
  const fake = installFakeDb(seed, {
    failOn: ({ table, op, payload }) => (failing && table === 'branches' && op === 'update' && payload?.marketplace_barbershop_id
      ? { code: '57014', message: 'canceling statement due to statement timeout' }
      : null),
  });
  try {
    const first = makeRes();
    await barbershops.create(staffReq(COMPANY_C, { body: { name: 'New', branch_ids: [BRANCH_C1] } }), first);
    assert.equal(first.statusCode, 500);
    assert.equal(fake.tables().marketplace_barbershops.length, 0, 'no orphan barbershop row');
    assert.equal(fake.tables().branches[0].marketplace_barbershop_id, null);

    failing = false;
    const retry = makeRes();
    await barbershops.create(staffReq(COMPANY_C, { body: { name: 'New', branch_ids: [BRANCH_C1] } }), retry);
    assert.equal(retry.statusCode, 201);
    assert.equal(fake.tables().marketplace_barbershops.length, 1);
    assert.equal(fake.tables().branches[0].marketplace_barbershop_id, retry.body.entry.id);
  } finally {
    fake.restore();
  }
});

test('M2: create rolls back when the schedule copy to branches fails', async () => {
  const seed = { marketplace_barbershops: [], branches: [{ id: BRANCH_C1, company_id: COMPANY_C, marketplace_barbershop_id: null }], users: [] };
  const fake = installFakeDb(seed, {
    failOn: ({ table, op, payload }) => (table === 'branches' && op === 'update' && payload && 'timezone' in payload
      ? { code: 'XX000', message: 'boom' }
      : null),
  });
  try {
    const res = makeRes();
    await barbershops.create(staffReq(COMPANY_C, { body: { name: 'New', timezone: 'Asia/Tashkent', branch_ids: [BRANCH_C1] } }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(fake.tables().marketplace_barbershops.length, 0);
    assert.equal(fake.tables().branches[0].marketplace_barbershop_id, null, 'branch link undone');
  } finally {
    fake.restore();
  }
});

// ----------------------------------------------------------------------- L2

test('L2: only the company_id unique violation maps to COMPANY_BARBERSHOP_EXISTS', async () => {
  const run = async (error) => {
    const fake = installFakeDb({ marketplace_barbershops: [], branches: [], users: [] }, {
      failOn: ({ table, op }) => (table === 'marketplace_barbershops' && op === 'insert' ? error : null),
    });
    const res = makeRes();
    try {
      await barbershops.create(staffReq(COMPANY_C, { body: { name: 'New' } }), res);
    } finally {
      fake.restore();
    }
    return res;
  };

  const race = await run({ code: '23505', constraint: 'marketplace_barbershops_company_id_key', message: 'duplicate key' });
  assert.equal(race.statusCode, 409);
  assert.equal(race.body.code, 'COMPANY_BARBERSHOP_EXISTS');

  const other = await run({ code: '23505', constraint: 'marketplace_barbershops_slug_key', message: 'duplicate key' });
  assert.equal(other.statusCode, 409);
  assert.notEqual(other.body.code, 'COMPANY_BARBERSHOP_EXISTS');

  const unnamed = await run({ code: '23505', message: 'duplicate key' });
  assert.notEqual(unnamed.body.code, 'COMPANY_BARBERSHOP_EXISTS');
});

test('L2: the postgres builder keeps the violated constraint name on errors', async () => {
  const { pool, db } = require('../src/config/postgres');
  const original = pool.query;
  pool.query = async () => {
    const error = new Error('duplicate key value violates unique constraint');
    Object.assign(error, { code: '23505', constraint: 'marketplace_barbershops_company_id_key' });
    throw error;
  };
  try {
    const { error } = await db.from('marketplace_barbershops').insert({ name: 'x' }).select('id').maybeSingle();
    assert.equal(error.code, '23505');
    assert.equal(error.constraint, 'marketplace_barbershops_company_id_key');
  } finally {
    pool.query = original;
  }
});

// ----------------------------------------------------------------------- L1

const USER_ID = '11111111-1111-4111-8111-111111111111';

async function runAccess({ tokenRole, dbRole, path = '/api/branches' }) {
  const sessions = [];
  let loaded = false;
  const middleware = createEmployeeAccessMiddleware({
    loadState: async () => {
      loaded = true;
      return { user: { id: USER_ID, role: dbRole, company_id: COMPANY_A, company_status: 'active' }, barber: null };
    },
    validateSession: async (input) => { sessions.push(input); return { valid: false, reason: 'revoked' }; },
  });
  const token = jwt.sign({ sub: USER_ID, companyId: COMPANY_A, role: tokenRole, branchId: 'b', jti: 's' }, process.env.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: path, path };
  const res = makeRes();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled, loaded, sessions };
}

test('L1: a token role with different casing/whitespace is still tenant-checked (no bypass)', async () => {
  for (const tokenRole of ['Barber', ' BARBER ', 'Admin_Network']) {
    const dbRole = tokenRole.trim().toLowerCase();
    const result = await runAccess({ tokenRole, dbRole });
    assert.equal(result.loaded, true, `${tokenRole}: account loaded`);
    if (dbRole === 'barber') {
      assert.equal(result.nextCalled, false, `${tokenRole}: session binding enforced`);
      assert.equal(result.res.statusCode, 401);
      assert.equal(result.res.body.code, 'SESSION_REVOKED');
    } else {
      assert.equal(result.nextCalled, true);
      assert.equal(result.req.tenant.companyId, COMPANY_A);
    }
  }
});

test('L1: session binding follows the DB role and is validated with it', async () => {
  const result = await runAccess({ tokenRole: 'Manager', dbRole: 'manager' });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].role, 'manager');
  assert.equal(result.res.statusCode, 401);
});
