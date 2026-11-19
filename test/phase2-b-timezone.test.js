// Phase 2 (group B) M5: statistics/quality ranges, expense/penalty "today" use
// the branch timezone -> company timezone -> default instead of a fixed
// Asia/Tashkent. The default keeps the legacy +05:00 output byte-for-byte.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'phase2-b-timezone-secret';

const postgres = require('../src/config/postgres');
const { zonedMidnightIso, zonedDateKey, resolveTimezone } = require('../src/utils/tenantTimezone');
const { normalizeStatisticsDateRange, normalizeOptionalDateRange, toZonedDateKey, toTashkentDateKey } = require('../src/utils/statisticsDate');
const { parseDateRange } = require('../src/utils/employeeQualityAccess');
const penalties = require('../src/models/penalties');

const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const ADMIN_B = '20000000-0000-4000-8000-00000000000b';

test('zonedMidnightIso keeps the legacy Tashkent format and follows other zones', () => {
  assert.equal(zonedMidnightIso('2026-11-18', 'Asia/Tashkent'), '2026-11-18T00:00:00+05:00');
  assert.equal(zonedMidnightIso('2026-11-18', 'Europe/Moscow'), '2026-11-18T00:00:00+03:00');
  assert.equal(zonedMidnightIso('2026-07-01', 'America/New_York'), '2026-07-01T00:00:00-04:00');
  assert.equal(zonedMidnightIso('2026-12-01', 'America/New_York'), '2026-12-01T00:00:00-05:00');
});

test('statistics ranges: default is unchanged, a company timezone moves the bounds', () => {
  assert.deepEqual(normalizeStatisticsDateRange('2026-11-01', '2026-11-02'), {
    endDate: '2026-11-02',
    endExclusive: '2026-11-03T00:00:00+05:00',
    startDate: '2026-11-01',
    startInclusive: '2026-11-01T00:00:00+05:00',
  });
  const moscow = normalizeStatisticsDateRange('2026-11-01', '2026-11-02', { timeZone: 'Europe/Moscow' });
  assert.equal(moscow.startInclusive, '2026-11-01T00:00:00+03:00');
  assert.equal(moscow.endExclusive, '2026-11-03T00:00:00+03:00');
  const optional = normalizeOptionalDateRange('2026-11-01', '2026-11-01', { timeZone: 'Asia/Almaty' });
  assert.equal(optional.startInclusive, zonedMidnightIso('2026-11-01', 'Asia/Almaty'));

  const instant = '2026-11-18T20:30:00Z';
  assert.equal(toTashkentDateKey(instant), '2026-11-19');
  assert.equal(toZonedDateKey(instant, 'Europe/Moscow'), '2026-11-18');
});

test('quality/statistics access ranges use the given timezone', () => {
  const legacy = parseDateRange({ start_date: '2026-11-01', end_date: '2026-11-01' });
  assert.equal(legacy.startInclusive, '2026-11-01T00:00:00+05:00');
  const moscow = parseDateRange({ start_date: '2026-11-01', end_date: '2026-11-01' }, 'Europe/Moscow');
  assert.equal(moscow.startInclusive, '2026-11-01T00:00:00+03:00');
  assert.equal(moscow.endExclusive, '2026-11-02T00:00:00+03:00');
});

test('resolveTimezone ignores a branch of another company (falls back to the caller company)', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/from branches b/.test(sql)) return { rows: [] }; // branch not in company B
    return { rows: [{ timezone: 'Asia/Almaty' }] };
  };
  assert.equal(await resolveTimezone({ branchId: BRANCH_B1, companyId: COMPANY_B }, { query }), 'Asia/Almaty');
  assert.deepEqual(calls[0].params, [BRANCH_B1, COMPANY_B]);
});

test('penalties create: penalty day is the branch-timezone day', async () => {
  // UTC+14 and UTC-11 are always on different calendar days.
  for (const timeZone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    const originalFrom = postgres.db.from;
    const originalQuery = postgres.pool.query;
    const user = { id: ADMIN_B, role: 'admin', branch_id: null, company_id: COMPANY_B };
    const chain = (data) => ({
      select() { return this; }, eq() { return this; }, maybeSingle() { return this; },
      then(resolve, reject) { return Promise.resolve({ data, error: null }).then(resolve, reject); },
    });
    postgres.db.from = (table) => (table === 'users' ? chain(user) : chain([]));
    const seen = [];
    postgres.pool.query = async (sql, params = []) => {
      seen.push({ sql: String(sql), params });
      if (/select id from branches where company_id/.test(sql)) return { rows: [{ id: BRANCH_B1 }] };
      if (/c\.timezone as company_timezone/.test(sql)) return { rows: [{ timezone: timeZone, company_timezone: 'Asia/Tashkent' }] };
      if (/from barbers where id = \$1/.test(sql)) return { rows: [{ id: 'barber-b', name: 'B', branch_id: BRANCH_B1 }] };
      if (/insert into warehouse_purchases/.test(sql)) return { rows: [{ id: 'pen-new' }] };
      if (/from warehouse_purchases p/.test(sql)) return { rows: [{ id: 'pen-new', branch_id: BRANCH_B1, metadata: {} }] };
      return { rows: [] };
    };
    try {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      const token = jwt.sign({ sub: ADMIN_B, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
      await penalties.create({ headers: { authorization: `Bearer ${token}` }, body: { branch_id: BRANCH_B1, recipient_id: 'barber-b', amount: 1000 } }, res);
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      const insert = seen.find((q) => /insert into warehouse_purchases/.test(q.sql));
      assert.ok(insert.params.includes(zonedDateKey(new Date(), timeZone)), `${timeZone}: ${JSON.stringify(insert.params)}`);
    } finally {
      postgres.db.from = originalFrom;
      postgres.pool.query = originalQuery;
    }
  }
});

test('no fixed Asia/Tashkent left in the group B files', () => {
  const fs = require('node:fs');
  for (const rel of ['src/models/employeeQuality.js', 'src/models/expenses.js', 'src/utils/statisticsDate.js', 'src/models/penalties.js']) {
    assert.doesNotMatch(fs.readFileSync(rel, 'utf8'), /'Asia\/Tashkent'|\+05:00/, rel);
  }
});
