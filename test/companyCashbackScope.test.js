// Phase 1 step B2a: cashback, loyalty and referral settings/prices are read
// for the company of the queue entry / referral, never globally.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.PGDATABASE ||= 'company-cashback-scope-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'company-cashback-scope-tests';
process.env.JWT_SECRET ||= 'company-cashback-scope-secret';

const { installDbMock, installPoolMock, eqCalls } = require('./helpers/tenantMocks');
const cashback = require('../src/composable/cashback');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

test('cashback totals only price services of the entry company', async () => {
  const pool = installPoolMock(() => ({ rows: [] }));
  const mock = installDbMock({ services: [{ data: [], error: null }], promo_code_usage: [{ data: null, error: null }] });
  try {
    const totals = await cashback.computeCashbackTotalsForQueueEntry({ id: 'q1', company_id: COMPANY_B, service_ids: ['service-of-a'] });
    assert.equal(totals.total, 0);
    assert.deepEqual(eqCalls(mock.calls, 'services', 'company_id'), [COMPANY_B]);
  } finally { mock.restore(); pool.restore(); }
});

test('cashback company falls back to the queue entry row, then the client', async () => {
  const pool = installPoolMock((sql) => {
    if (/from queue_entries/.test(sql)) return { rows: [] };
    if (/from clients/.test(sql)) return { rows: [{ company_id: COMPANY_A }] };
    return { rows: [] };
  });
  try {
    assert.equal(await cashback.getCompanyIdForEntry({ id: 'q1', client_id: 'c1' }), COMPANY_A);
    assert.equal(await cashback.getCompanyIdForEntry({ company_id: COMPANY_B }), COMPANY_B);
  } finally { pool.restore(); }
});

test('cashback percent reads platform_settings of the entry company', async () => {
  const pool = installPoolMock((sql) => {
    if (/platform_settings/.test(sql)) return { rows: [{ value: { default_percent: 7 } }] };
    return { rows: [] };
  });
  const mock = installDbMock({
    services: [{ data: [{ id: 's1', base_price: 100 }], error: null }],
    promo_code_usage: [{ data: null, error: null }],
    cashback_transactions: [{ data: null, error: null }],
  });
  try {
    await cashback.awardCashbackForCompletedQueueEntry({
      id: 'q1', client_id: 'c1', company_id: COMPANY_B, status: 'completed', service_ids: ['s1'], payment_method: 'cash',
    }).catch(() => null);
    const settings = pool.calls.filter((call) => /platform_settings/.test(call.sql));
    assert.ok(settings.length >= 1);
    for (const call of settings) {
      assert.match(call.sql, /company_id = \$1/);
      assert.equal(call.params[0], COMPANY_B);
    }
  } finally { mock.restore(); pool.restore(); }
});

test('cashback spend policy is read for the entry company', async () => {
  const pool = installPoolMock(() => ({ rows: [{ balance: 0 }] }));
  const mock = installDbMock({
    services: [{ data: [{ id: 's1', base_price: 100, company_id: COMPANY_B, branch_id: null }], error: null }],
    promo_code_usage: [{ data: null, error: null }],
    platform_settings: [{ data: { value: { max_redeem_share: 0.1 } }, error: null }],
  });
  try {
    await cashback.spendCashbackForQueueEntry({ id: 'q1', client_id: 'c1', company_id: COMPANY_B, service_ids: ['s1'] }, 50).catch(() => null);
    assert.deepEqual(eqCalls(mock.calls, 'platform_settings', 'company_id'), [COMPANY_B]);
  } finally { mock.restore(); pool.restore(); }
});

// referralBonus is SQL-heavy: contract checks on the source.
const referral = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'referralBonus.js'), 'utf8');

test('referral wallet client is resolved per (company, phone), never by phone alone', () => {
  assert.doesNotMatch(referral, /on conflict \(phone\)/);
  assert.match(referral, /on conflict \(company_id, phone\)/);
  assert.match(referral, /insert into clients \(company_id, name, phone\)/);
  assert.match(referral, /where company_id = \$2\s+and regexp_replace/);
});

test('referral settlement stays inside the referral company (orders, prices, settings)', () => {
  assert.match(referral, /and q\.company_id = r\.company_id/);
  assert.match(referral, /referred_c\.company_id = r\.company_id/);
  assert.match(referral, /s\.company_id = q\.company_id and s\.id = any\(q\.service_ids\)/);
  assert.doesNotMatch(referral, /from platform_settings where key = /);
  assert.match(referral, /where company_id = r\.company_id and key = 'referral'/);
});
