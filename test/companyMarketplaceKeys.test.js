// MULTI_TENANCY B2 — marketplace code that used global keys (platform_settings
// by key, clients by phone, referral codes) is company scoped. These are the
// call sites that blocked deferred/101 (now migration 007).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'company-marketplace-keys-secret';

const { installDbMock, installPoolMock, makeRes } = require('./helpers/tenantMocks');
const { findReferralAccountByCode } = require('../src/utils/referralAccounts');
const { readTenantSetting } = require('../src/utils/tenantSettings');
const noShow = require('../src/services/marketplaceNoShowRestriction');
const compliance = require('../src/models/marketplace/compliance');
const groupBooking = require('../src/models/marketplace/groupBooking');
const catalogService = require('../src/modules/marketplace/catalog/service');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const CLIENT = 'cccccccc-0000-4000-8000-00000000000c';
const BARBER_B = 'dddddddd-0000-4000-8000-00000000000d';
const SERVICE_B = 'eeeeeeee-0000-4000-8000-00000000000e';

const marketplaceAuth = () => ({ authorization: `Bearer ${jwt.sign({ sub: CLIENT, role: 'marketplace' }, process.env.JWT_SECRET)}` });
const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

// ------------------------------------------------------------ settings helper

test('readTenantSetting reads tenant_setting(key, company) and never the bare key', async () => {
  const calls = [];
  const fake = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ value: { x: 1 } }] }; } };
  assert.deepEqual(await readTenantSetting(fake, 'referral', COMPANY_B), { x: 1 });
  assert.match(calls[0].sql, /tenant_setting\(\$1, \$2::uuid\)/);
  assert.deepEqual(calls[0].params, ['referral', COMPANY_B]);
  assert.equal(await readTenantSetting(fake, 'referral', null), null, 'no company -> defaults, no query');
  assert.equal(calls.length, 1);
});

// ------------------------------------------------------------ referral codes

test('referral code resolving to two companies is rejected (no arbitrary pick)', async () => {
  const fake = { query: async () => ({ rows: [
    { marketplace_client_id: 'r1', referral_code: 'BRX', company_id: COMPANY_A },
    { marketplace_client_id: 'r2', referral_code: 'BRX', company_id: COMPANY_B },
  ] }) };
  assert.equal(await findReferralAccountByCode(fake, 'brx', CLIENT), null);
});

test('referral code with exactly one account returns it with its company', async () => {
  let seen;
  const fake = { query: async (sql, params) => { seen = { sql, params }; return { rows: [{ marketplace_client_id: 'r2', referral_code: 'BRX', company_id: COMPANY_B }] }; } };
  const account = await findReferralAccountByCode(fake, ' brx ', CLIENT);
  assert.equal(account.company_id, COMPANY_B);
  assert.match(seen.sql, /limit 2/);
  assert.deepEqual(seen.params, ['BRX', CLIENT]);
});

test('sign-up referral paths bind the referral to the account company', () => {
  for (const file of ['src/models/marketplace/auth.js', 'src/services/telegramAuth.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /from referral_accounts\s+where referral_code = \$1/, file);
    assert.doesNotMatch(source, /platform_settings where key/, file);
    assert.match(source, /findReferralAccountByCode\(/, file);
    assert.match(source, /insert into referrals[\s\S]{0,80}\(referrer_client_id, referred_client_id, referral_code, expires_at, source_ip, device_id, company_id\)/, file);
  }
  const bonus = read('src/services/referralBonus.js');
  assert.match(bonus, /other\.company_id is distinct from ra\.company_id/);
  assert.match(bonus, /candidate\.company_id/);
});

test('no src/ file reads platform_settings by key alone', () => {
  const root = path.resolve(__dirname, '..', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.js')) continue;
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!/platform_settings/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
        const window = lines.slice(Math.max(0, index - 2), index + 4).join('\n');
        if (/company_id/.test(window)) return;
        offenders.push(`${path.relative(root, full)}:${index + 1}`);
      });
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

// ------------------------------------------------------------ no-show

test('no-show restriction uses the missed order company settings and records the company', async () => {
  const pool = installPoolMock((sql) => {
    if (/from queue_entries q/.test(sql)) return { rows: [{ id: 'q1', client_id: 'c1', status: 'no_show', company_id: COMPANY_B, marketplace_client_id: CLIENT }] };
    if (/tenant_setting/.test(sql)) return { rows: [{ value: { lookback_days: 30 } }] };
    if (/insert into marketplace_no_show_violations/.test(sql)) return { rows: [{ id: 'v1' }] };
    if (/select count\(\*\)::int as count from marketplace_no_show_violations/.test(sql)) return { rows: [{ count: 1 }] };
    if (/from marketplace_clients where id = \$1 for update/.test(sql)) return { rows: [{ id: CLIENT, blocked_until: null }] };
    return { rows: [] };
  });
  try {
    await noShow.registerConfirmedNoShow('q1');
    const setting = pool.calls.find((c) => /tenant_setting/.test(c.sql));
    assert.deepEqual(setting.params, ['no_show_restrictions', COMPANY_B]);
    const insert = pool.calls.find((c) => /insert into marketplace_no_show_violations/.test(c.sql));
    assert.equal(insert.params[2], COMPANY_B);
    const count = pool.calls.find((c) => /count\(\*\)::int as count from marketplace_no_show_violations/.test(c.sql));
    assert.equal(count.params[2], COMPANY_B);
    assert.equal(pool.calls.some((c) => /platform_settings where key/.test(c.sql)), false);
  } finally {
    pool.restore();
  }
});

// ------------------------------------------------------------ loyalty screen

test('loyalty screen: two companies and no branch_id -> 400 BRANCH_REQUIRED', async () => {
  const db = installDbMock({ companies: [{ data: [{ id: COMPANY_A, is_default: true, status: 'active' }, { id: COMPANY_B, is_default: false, status: 'active' }], error: null }] });
  const pool = installPoolMock((sql) => (/from marketplace_clients/.test(sql) ? { rows: [{ id: CLIENT, status_points: 50, is_active: true }] } : { rows: [] }));
  try {
    const res = makeRes();
    await compliance.loyalty({ headers: marketplaceAuth(), query: {}, body: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'BRANCH_REQUIRED');
    assert.equal(pool.calls.some((c) => /tenant_setting/.test(c.sql)), false);
  } finally {
    db.restore();
    pool.restore();
  }
});

test('loyalty screen: ?branch_id selects that branch company levels', async () => {
  const db = installDbMock({ branches: [{ data: { id: BRANCH_B1, company_id: COMPANY_B }, error: null }] });
  const pool = installPoolMock((sql) => {
    if (/from marketplace_clients/.test(sql)) return { rows: [{ id: CLIENT, status_points: 50, is_active: true }] };
    if (/tenant_setting/.test(sql)) return { rows: [{ value: { Silver: { min_points: 10, cashback_percent: 3 } } }] };
    return { rows: [] };
  });
  try {
    const res = makeRes();
    await compliance.loyalty({ headers: marketplaceAuth(), query: { branch_id: BRANCH_B1 }, body: {} }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.level.name, 'Silver');
    const setting = pool.calls.find((c) => /tenant_setting/.test(c.sql));
    assert.deepEqual(setting.params, ['loyalty_levels', COMPANY_B]);
  } finally {
    db.restore();
    pool.restore();
  }
});

test('compliance: cancel and referral read settings of the booking/account company', () => {
  const source = read('src/models/marketplace/compliance.js');
  assert.doesNotMatch(source, /platform_settings where key/);
  assert.match(source, /marketplace_loyalty_level\(status_points, \$2::uuid\)/);
  assert.doesNotMatch(source, /marketplace_loyalty_level\(status_points\)/);
  assert.match(source, /insert into referral_accounts \(marketplace_client_id, referral_code, company_id\)/);
  assert.match(source, /where not exists \(select 1 from referral_accounts where referral_code = \$2\)/);
  assert.match(source, /legacy\.company_id = \$2/);
});

// ------------------------------------------------------------ group booking

test('group booking: settings, services, client and queue entry all use the branch company', async () => {
  const originalEnsure = catalogService.ensureBookingWithinWorkHours;
  catalogService.ensureBookingWithinWorkHours = async () => {};
  const pool = installPoolMock((sql) => {
    if (/select id, is_active from marketplace_clients/.test(sql)) return { rows: [{ id: CLIENT, is_active: true }] };
    if (/from marketplace_clients mc/.test(sql)) return { rows: [{ id: CLIENT, phone: '+998901112233', is_active: true }] };
    if (/from branches where id = \$1/.test(sql)) return { rows: [{ id: BRANCH_B1, company_id: COMPANY_B, timezone: 'Asia/Tashkent', is_active: true }] };
    if (/tenant_setting/.test(sql)) return { rows: [{ value: { max_daily_bookings: 5 } }] };
    if (/count\(\*\)::int as count from marketplace_bookings/.test(sql)) return { rows: [{ count: 0 }] };
    if (/from barbers where id = any/.test(sql)) return { rows: [{ id: BARBER_B }] };
    if (/from services\s+where id = any\(\$1::uuid\[\]\) and is_active/.test(sql)) return { rows: [{ id: SERVICE_B, duration_minutes: 30, base_price: 100 }] };
    if (/insert into marketplace_bookings/.test(sql)) return { rows: [{ id: 'booking-1' }] };
    if (/select id from clients/.test(sql)) return { rows: [] };
    if (/insert into clients/.test(sql)) return { rows: [{ id: 'client-b' }] };
    if (/insert into queue_entries/.test(sql)) return { rows: [{ id: 'queue-1', status: 'waiting' }] };
    if (/insert into marketplace_booking_persons/.test(sql)) return { rows: [{ id: 'person-1' }] };
    return { rows: [] };
  });
  try {
    const res = makeRes();
    await groupBooking.create({
      headers: marketplaceAuth(),
      get: () => null,
      app: { get: () => null },
      body: { branch_id: BRANCH_B1, payment_method: 'cash', persons: [{ name: 'A', barber_id: BARBER_B, service_ids: [SERVICE_B] }] },
    }, res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const limits = pool.calls.find((c) => /tenant_setting\('booking_limits'/.test(c.sql));
    assert.deepEqual(limits.params, [COMPANY_B]);
    const services = pool.calls.find((c) => /from services\s+where id = any\(\$1::uuid\[\]\) and is_active/.test(c.sql));
    assert.match(services.sql, /company_id = \$3/);
    assert.equal(services.params[2], COMPANY_B);
    const lookup = pool.calls.find((c) => /select id from clients/.test(c.sql));
    assert.equal(lookup.params[0], COMPANY_B);
    const insertClient = pool.calls.find((c) => /insert into clients/.test(c.sql));
    assert.match(insertClient.sql, /on conflict \(company_id, phone\)/);
    assert.equal(insertClient.params[0], COMPANY_B);
    const queue = pool.calls.find((c) => /insert into queue_entries/.test(c.sql));
    assert.equal(queue.params[6], COMPANY_B);
    const prices = pool.calls.find((c) => /insert into marketplace_booking_person_services/.test(c.sql));
    assert.match(prices.sql, /company_id = \$3 and \(branch_id is null or branch_id = \$4\)/);
    assert.deepEqual(prices.params.slice(2), [COMPANY_B, BRANCH_B1]);
  } finally {
    catalogService.ensureBookingWithinWorkHours = originalEnsure;
    pool.restore();
  }
});

test('group booking: a branch without company fails closed', async () => {
  const pool = installPoolMock((sql) => {
    if (/select id, is_active from marketplace_clients/.test(sql)) return { rows: [{ id: CLIENT, is_active: true }] };
    if (/from marketplace_clients mc/.test(sql)) return { rows: [{ id: CLIENT, phone: '+998901112233', is_active: true }] };
    if (/from branches where id = \$1/.test(sql)) return { rows: [{ id: BRANCH_B1, company_id: null, is_active: true }] };
    return { rows: [] };
  });
  try {
    const res = makeRes();
    await groupBooking.create({
      headers: marketplaceAuth(), get: () => null, app: { get: () => null },
      body: { branch_id: BRANCH_B1, persons: [{ name: 'A', barber_id: BARBER_B, service_ids: [SERVICE_B] }] },
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(pool.calls.some((c) => /insert into queue_entries/.test(c.sql)), false);
  } finally {
    pool.restore();
  }
});
