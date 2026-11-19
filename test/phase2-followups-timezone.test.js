// Phase 2 follow-ups (M5): one tenantTimezone module, and the remaining
// business-day calculations (statistics, referral daily cap, group booking
// daily limit, queue auto-close) follow branch -> company -> default.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';

const postgres = require('../src/config/postgres');
const tz = require('../src/utils/tenantTimezone');
const statistics = require('../src/models/statistics');
const { awardFirstVisitReferralPoints } = require('../src/services/referralBonus');
const { groupTargetsByTimezone } = require('../src/jobs/autoCloseQueue');

const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const makeRes = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

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

// ---------------------------------------------------------------- module API

test('tenantTimezone: aliases and wrappers share one implementation', async () => {
  assert.equal(tz.effectiveTimeZone, tz.pickTimezone);
  assert.equal(tz.pickTimezone('', null, 'Bad/Zone', 'Europe/Moscow'), 'Europe/Moscow');
  assert.equal(tz.pickTimezone(), tz.DEFAULT_TIMEZONE);
  assert.equal(tz.isValidTimeZone('Asia/Almaty'), true);
  assert.equal(tz.isValidTimeZone('Nope/Nope'), false);
  assert.equal(tz.isValidTimeZone(42), false);

  const branchDb = { query: async () => ({ rows: [{ timezone: null, company_timezone: 'Asia/Almaty' }] }) };
  assert.equal(await tz.branchTimeZone(BRANCH_B1, { db: branchDb }), 'Asia/Almaty');
  assert.equal(await tz.branchTimeZone(BRANCH_B1, { query: branchDb.query }), 'Asia/Almaty');
  assert.equal(await tz.branchTimeZone(null, { db: branchDb }), tz.DEFAULT_TIMEZONE);

  const companyDb = { query: async (sql) => ({ rows: /from companies/.test(sql) ? [{ timezone: 'Europe/Moscow' }] : [] }) };
  assert.equal(await tz.companyTimeZone(COMPANY_B, { db: companyDb }), 'Europe/Moscow');
  assert.equal(await tz.companyTimeZone(null, { db: companyDb }), tz.DEFAULT_TIMEZONE);
  // Missing branch row -> default (no company given).
  assert.equal(await tz.branchTimeZone(BRANCH_B1, { db: { query: async () => ({ rows: [] }) } }), tz.DEFAULT_TIMEZONE);
});

test('tenantTimezone: zonedDateKey accepts Date, ISO and epoch ms; rejects garbage', () => {
  const instant = Date.parse('2026-11-18T20:30:00Z');
  assert.equal(tz.zonedDateKey(new Date(instant), 'Asia/Tashkent'), '2026-11-19');
  assert.equal(tz.zonedDateKey('2026-11-18T20:30:00Z', 'Europe/Moscow'), '2026-11-18');
  assert.equal(tz.zonedDateKey(instant, 'Europe/Moscow'), '2026-11-18');
  assert.equal(tz.zonedDateKey('not a date'), null);
  // An invalid zone falls back to the default instead of throwing.
  assert.equal(tz.zonedDateKey(instant, 'Bad/Zone'), '2026-11-19');
});

// ---------------------------------------------------------------- statistics

test('statistics: company timezone moves day bounds and daily buckets', async () => {
  const handler = (sql) => {
    if (/from companies where id/.test(sql)) return { rows: [{ timezone: 'Europe/Moscow' }] };
    if (/FROM "queue_entries"/.test(sql)) {
      // 20:30Z = 23:30 Moscow on Nov 1 (01:30 Nov 2 in Tashkent).
      return { rows: [{ id: 'q1', client_id: 'c1', branch_id: null, barber_id: null, status: 'completed', created_at: '2026-11-01T20:30:00Z' }] };
    }
    return { rows: [] };
  };
  await withSql(handler, async (seen) => {
    const res = makeRes();
    await statistics.all({
      query: { start_date: '2026-11-01', end_date: '2026-11-01' },
      statisticsAccess: { scope: { type: 'global', companyId: COMPANY_B }, user: { company_id: COMPANY_B } },
    }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const entries = seen.find((q) => /FROM "queue_entries"/.test(q.sql));
    assert.ok(entries.params.includes('2026-11-01T00:00:00+03:00'), JSON.stringify(entries.params));
    assert.ok(entries.params.includes('2026-11-02T00:00:00+03:00'), JSON.stringify(entries.params));
    assert.deepEqual(res.body.raw.by_day, { '2026-11-01': 1 });
  });
});

test('statistics: branch scope uses the branch timezone and the caller company', async () => {
  const handler = (sql) => {
    if (/from branches b/.test(sql)) return { rows: [{ timezone: 'Asia/Almaty', company_timezone: 'Europe/Moscow' }] };
    return { rows: [] };
  };
  await withSql(handler, async (seen) => {
    const res = makeRes();
    await statistics.branch({
      params: { branch: BRANCH_B1 },
      query: { start_date: '2026-11-01', end_date: '2026-11-01' },
      statisticsAccess: { scope: { type: 'global', companyId: COMPANY_B }, user: { company_id: COMPANY_B } },
    }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const lookup = seen.find((q) => /from branches b/.test(q.sql));
    assert.deepEqual(lookup.params, [BRANCH_B1, COMPANY_B]);
    const entries = seen.find((q) => /FROM "queue_entries"/.test(q.sql));
    assert.ok(entries.params.includes(tz.zonedMidnightIso('2026-11-01', 'Asia/Almaty')), JSON.stringify(entries.params));
  });
});

test('statistics: invalid dates are still refused before any query', async () => {
  await withSql(() => ({ rows: [] }), async (seen) => {
    const res = makeRes();
    await statistics.all({
      query: { start_date: '2026-11-05', end_date: '2026-11-01' },
      statisticsAccess: { scope: { type: 'global', companyId: COMPANY_B }, user: { company_id: COMPANY_B } },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(seen.length, 0);
  });
});

test('statistics: manager range is computed in the manager branch timezone', async () => {
  const handler = (sql) => {
    if (/from branches b/.test(sql)) return { rows: [{ timezone: 'Europe/Moscow', company_timezone: null }] };
    return { rows: [] };
  };
  await withSql(handler, async (seen) => {
    const res = makeRes();
    await statistics.manager({
      query: { start_date: '2026-11-01', end_date: '2026-11-01' },
      statisticsAccess: { user: { role: 'manager', branch_id: BRANCH_B1, company_id: COMPANY_B } },
    }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const orders = seen.find((q) => /from queue_entries q/.test(q.sql));
    assert.deepEqual(orders.params, [BRANCH_B1, '2026-11-01T00:00:00+03:00', '2026-11-02T00:00:00+03:00']);
  });
});

// ---------------------------------------------------------------- referral cap

test('referral first-visit points: daily cap is checked in the company timezone', async () => {
  const seen = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      seen.push({ sql: text, params });
      if (/from referrals r/.test(text)) {
        return { rows: [{ referral_id: 'r1', referrer_client_id: 'mc1', company_id: COMPANY_B, points: 15 }] };
      }
      if (/from companies where id/.test(text)) return { rows: [{ timezone: 'Europe/Moscow' }] };
      if (/daily_positive_limit/.test(text)) return { rows: [{ daily_limit: 20 }] };
      if (/sum\(amount\)/.test(text)) return { rows: [{ total: 20 }] }; // cap reached -> skip
      return { rows: [] };
    },
  };
  const awarded = await awardFirstVisitReferralPoints(client);
  assert.equal(awarded, 0);
  const earned = seen.find((q) => /sum\(amount\)/.test(q.sql));
  assert.deepEqual(earned.params, ['mc1', 'Europe/Moscow']);
  assert.match(earned.sql, /at time zone \$2/);
});

// ---------------------------------------------------------------- branch rows

test('timezoneOfBranchRow: own zone without a query, else company, else branch join', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/from companies where id/.test(sql)) return { rows: [{ timezone: 'Asia/Almaty' }] };
    if (/from branches b/.test(sql)) return { rows: [{ timezone: null, company_timezone: 'Europe/Moscow' }] };
    return { rows: [] };
  };
  assert.equal(await tz.timezoneOfBranchRow({ id: BRANCH_B1, timezone: 'Europe/Moscow', company_id: COMPANY_B }, { query }), 'Europe/Moscow');
  assert.equal(calls.length, 0);
  assert.equal(await tz.timezoneOfBranchRow({ id: BRANCH_B1, timezone: null, company_id: COMPANY_B }, { query }), 'Asia/Almaty');
  assert.deepEqual(calls.at(-1).params, [COMPANY_B]);
  assert.equal(await tz.timezoneOfBranchRow({ id: BRANCH_B1, timezone: 'Bad/Zone' }, { query }), 'Europe/Moscow');
  assert.equal(await tz.timezoneOfBranchRow(null, { query }), tz.DEFAULT_TIMEZONE);
});

// ---------------------------------------------------------------- cashback promo

test('cashback promotion window uses the company timezone when cashback.timezone is unset', async () => {
  const cashback = require('../src/composable/cashback');
  // UTC+14 vs UTC-11: "today" differs, so only one of them is inside the window.
  const today = tz.zonedDateKey(new Date(), 'Pacific/Kiritimati');
  for (const [companyZone, expected] of [['Pacific/Kiritimati', 9], ['Pacific/Pago_Pago', 1]]) {
    await withSql((sql) => {
      if (/platform_settings/.test(sql)) {
        return { rows: [{ value: { default_percent: 1, promotion_percent: 9, promotion_start_date: today, promotion_end_date: today } }] };
      }
      if (/from companies where id/.test(sql)) return { rows: [{ timezone: companyZone }] };
      return { rows: [] };
    }, async () => {
      const percent = await cashback.getCashbackPercentForEntry({ id: 'q1', client_id: 'c1', company_id: COMPANY_B });
      assert.equal(percent, expected, companyZone);
    });
  }
});

// ---------------------------------------------------------------- source guards

test('no hard-coded Asia/Tashkent in the follow-up files', () => {
  for (const rel of [
    'src/composable/cashback.js',
    'src/models/kiosk.js',
    'src/models/verifix.js',
    'src/models/statistics.js',
    'src/services/referralBonus.js',
    'src/models/marketplace/groupBooking.js',
    'src/jobs/autoCloseQueue.js',
    'src/models/penalties.js',
  ]) {
    const source = read(rel);
    assert.doesNotMatch(source, /'Asia\/Tashkent'|\+05:00/, rel);
    assert.match(source, /require\('(\.\.\/)+utils\/tenantTimezone'\)/, `${rel} must use utils/tenantTimezone`);
  }
  const groupBooking = read('src/models/marketplace/groupBooking.js');
  assert.match(groupBooking, /resolveTimezone\(\{ branchId, companyId \}/);
  assert.match(groupBooking, /at time zone \$2\)::date = \(now\(\) at time zone \$2\)::date/);
});

// ---------------------------------------------------------------- auto-close

test('autoCloseQueue grouping keeps its precedence via tenantTimezone.pickTimezone', () => {
  const original = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    const groups = groupTargetsByTimezone({
      branches: [
        { id: 'b1', timezone: 'Europe/Moscow', company_timezone: 'Asia/Almaty' },
        { id: 'b2', timezone: null, company_timezone: 'Asia/Almaty' },
        { id: 'b3', timezone: 'Bad/Zone', company_timezone: null },
      ],
      companies: [{ id: 'c1', timezone: '' }],
      fallbackTimeZone: 'Asia/Tashkent',
    });
    assert.deepEqual(groups.get('Europe/Moscow'), { branchIds: ['b1'], companyIds: [] });
    assert.deepEqual(groups.get('Asia/Almaty'), { branchIds: ['b2'], companyIds: [] });
    assert.deepEqual(groups.get('Asia/Tashkent'), { branchIds: ['b3'], companyIds: ['c1'] });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Invalid timezone "Bad\/Zone"/);
  } finally {
    console.warn = original;
  }
});

// ---------------------------------------------------------------- checkToday / merchant "today"

test('notifications checkToday: the day is bounded in the company timezone', async () => {
  process.env.JWT_SECRET ||= 'phase2-followups-secret';
  const jwt = require('jsonwebtoken');
  const notifications = require('../src/models/notifications');
  const ADMIN_B = '20000000-0000-4000-8000-00000000000b';
  const headers = { authorization: `Bearer ${jwt.sign({ sub: ADMIN_B, role: 'admin_network' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };
  await withSql((sql) => {
    if (/join companies c on c\.id = u\.company_id/.test(sql)) return { rows: [{ company_id: COMPANY_B }] };
    if (/from companies where id/.test(sql)) return { rows: [{ timezone: 'Europe/Moscow' }] };
    return { rows: [] };
  }, async (seen) => {
    const res = makeRes();
    await notifications.notifications.checkToday({ headers, employeeAccess: { user: { id: ADMIN_B, role: 'admin_network' }, sessionValid: true }, body: { date: '2026-11-18' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const orders = seen.find((q) => /FROM "queue_entries"/.test(q.sql));
    assert.ok(orders.params.includes('2026-11-18T00:00:00+03:00'), JSON.stringify(orders.params));
    assert.ok(orders.params.includes('2026-11-19T00:00:00+03:00'), JSON.stringify(orders.params));
  });
});

test('merchant dashboard: "today" uses the company timezone, not the DB session day', () => {
  const source = read('src/models/merchant.js');
  assert.doesNotMatch(source, /date_trunc\('day', now\(\)\)/);
  assert.match(source, /date_trunc\('day', now\(\) at time zone \$3\) at time zone \$3/);
  assert.match(source, /resolveTimezone\(\{ companyId: access\.user\.company_id \}/);
});
