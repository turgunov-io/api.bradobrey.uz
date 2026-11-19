// MULTI_TENANCY Phase 2 (group A, M5): "today" for referral limits, the
// marketplace cancel counter and same-day catalog bookings is the day of the
// relevant branch / company, not a hard-coded Asia/Tashkent. Effective
// timezone: branches.timezone -> companies.timezone -> DEFAULT_TIMEZONE
// (same order as jobs/autoCloseQueue groupTargetsByTimezone).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';

const {
  DEFAULT_TIMEZONE,
  pickTimezone,
  resolveTimezone,
} = require('../src/utils/tenantTimezone');
const catalogService = require('../src/modules/marketplace/catalog/service');

const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';

const fakeQuery = (rowsFor) => {
  const calls = [];
  const query = async (sql, params) => { calls.push({ sql, params }); return { rows: rowsFor(sql) }; };
  return { calls, query };
};

test('resolveTimezone (shared helper): branch -> company -> default', async () => {
  let db = fakeQuery(() => [{ timezone: 'Europe/Moscow', company_timezone: 'Asia/Almaty' }]);
  assert.equal(await resolveTimezone({ branchId: BRANCH_B1 }, db), 'Europe/Moscow');
  db = fakeQuery(() => [{ timezone: null, company_timezone: 'Asia/Almaty' }]);
  assert.equal(await resolveTimezone({ branchId: BRANCH_B1 }, db), 'Asia/Almaty');
  db = fakeQuery((sql) => (/from companies where id/.test(sql) ? [{ timezone: 'Asia/Almaty' }] : []));
  assert.equal(await resolveTimezone({ companyId: COMPANY_B }, db), 'Asia/Almaty');
  assert.equal(await resolveTimezone({}, fakeQuery(() => [])), DEFAULT_TIMEZONE);
  assert.equal(pickTimezone('Not/AZone'), DEFAULT_TIMEZONE);
});

test('catalog same-day check uses the given branch timezone (not a fixed zone)', () => {
  const now = new Date();
  assert.doesNotThrow(() => catalogService.ensureSameDay({ startsAt: now, branchTimezone: 'Pacific/Kiritimati' }));
  const tomorrow = new Date(now.getTime() + 26 * 3600 * 1000);
  assert.throws(() => catalogService.ensureSameDay({ startsAt: tomorrow, branchTimezone: 'Pacific/Kiritimati' }));
});

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('referral limits, cancel counter and catalog day use the resolved timezone', () => {
  for (const rel of [
    'src/models/marketplace/auth.js',
    'src/models/marketplace/compliance.js',
    'src/modules/marketplace/catalog/service.js',
  ]) {
    const source = read(rel);
    assert.doesNotMatch(source, /'Asia\/Tashkent'/, `${rel} still hard-codes Asia/Tashkent`);
    assert.match(source, /require\('(\.\.\/)+utils\/tenantTimezone'\)/, `${rel} must use utils/tenantTimezone`);
  }
  const auth = read('src/models/marketplace/auth.js');
  assert.doesNotMatch(auth, /at time zone '/);
  assert.match(auth, /at time zone \$\d/);
  const compliance = read('src/models/marketplace/compliance.js');
  assert.match(compliance, /cancel_count_date = \(now\(\) at time zone \$\d+\)::date/);
});
