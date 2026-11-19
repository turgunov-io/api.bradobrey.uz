// Phase 1 step B2a: per-company settings rows (kiosk ads, rank settings,
// loyalty levels / platform_settings, verifix penalty rate, marketplace
// settings, marketplace profile). Company B never reads or writes company A's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.PGDATABASE ||= 'company-settings-scope-tests';
process.env.PGHOST ||= '127.0.0.1';
process.env.PGUSER ||= 'company-settings-scope-tests';
process.env.JWT_SECRET ||= 'company-settings-scope-secret';

const { installDbMock, installPoolMock, makeRes, eqCalls } = require('./helpers/tenantMocks');
const postgres = require('../src/config/postgres');

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ADMIN_B = '10000000-0000-4000-8000-00000000000b';
const BRANCH_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';


const bearer = (role = 'admin_network') => `Bearer ${jwt.sign({ sub: ADMIN_B, role }, process.env.JWT_SECRET)}`;
// createAdminAuth loads users/barbers/companies through employeeAccess.
const staffTables = (role = 'admin_network') => ({
  users: [{ data: { id: ADMIN_B, login: 'b', role, branch_id: null, company_id: COMPANY_B }, error: null }],
  barbers: [{ data: null, error: null }],
  companies: [{ data: { id: COMPANY_B, status: 'active' }, error: null }],
});

const kioskAds = require('../src/models/kioskAds');
const loyalty = require('../src/models/loyalty');

test('kiosk ads: read/write the caller company row, never id = 1', async () => {
  let mock = installDbMock({ ...staffTables(), kiosk_ad_settings: [{ data: { id: 7 }, error: null }] });
  try {
    const res = makeRes();
    await kioskAds.getSettings({ headers: { authorization: bearer() } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(eqCalls(mock.calls, 'kiosk_ad_settings', 'company_id'), [COMPANY_B]);
    assert.deepEqual(eqCalls(mock.calls, 'kiosk_ad_settings', 'id'), []);
  } finally { mock.restore(); }

  mock = installDbMock({ ...staffTables(), kiosk_ad_settings: [{ data: { id: 7 }, error: null }] });
  try {
    const res = makeRes();
    await kioskAds.updateSettings({ headers: { authorization: bearer() }, body: { regular_urls: ['https://youtu.be/x'], company_id: COMPANY_A } }, res);
    assert.equal(res.statusCode, 200);
    const upsert = mock.calls.find((c) => c.table === 'kiosk_ad_settings' && c.method === 'upsert');
    assert.equal(upsert.args[0].company_id, COMPANY_B);
    assert.equal('id' in upsert.args[0], false);
    assert.equal(upsert.args[1].onConflict, 'company_id');
  } finally { mock.restore(); }
});

test('loyalty: levels and rank settings are per company (upsert on company_id,key)', async () => {
  let mock = installDbMock({
    ...staffTables(),
    platform_settings: [{ data: null, error: null }],
    client_rank_settings: [{ data: null, error: null }],
  });
  try {
    const res = makeRes();
    await loyalty.getRankSettings({ headers: { authorization: bearer() } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(eqCalls(mock.calls, 'platform_settings', 'company_id'), [COMPANY_B]);
    assert.deepEqual(eqCalls(mock.calls, 'client_rank_settings', 'company_id'), [COMPANY_B]);
  } finally { mock.restore(); }

  mock = installDbMock({
    ...staffTables(),
    client_rank_settings: [{ data: null, error: null }, { data: { id: 9 }, error: null }],
  });
  try {
    const res = makeRes();
    await loyalty.updateRankSettings({ headers: { authorization: bearer() }, body: { bronze_min_visits: 3 } }, res);
    assert.equal(res.statusCode, 200);
    const upsert = mock.calls.find((c) => c.table === 'client_rank_settings' && c.method === 'upsert');
    assert.equal(upsert.args[0].company_id, COMPANY_B);
    assert.equal('id' in upsert.args[0], false);
    assert.equal(upsert.args[1].onConflict, 'company_id');
  } finally { mock.restore(); }

  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'models', 'loyalty.js'), 'utf8');
  assert.match(source, /onConflict: 'company_id,key'/);
  assert.doesNotMatch(source, /onConflict: 'key'/);
  assert.doesNotMatch(source, /onConflict: 'id'/);
});

test('loyalty public ranks: company from ?branch_id; two companies and no branch -> 400', async () => {
  let mock = installDbMock({
    branches: [{ data: { id: BRANCH_B1, company_id: COMPANY_B }, error: null }],
    platform_settings: [{ data: null, error: null }],
  });
  try {
    const res = makeRes();
    await loyalty.getPublicRankSettings({ headers: {}, query: { branch_id: BRANCH_B1 } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(eqCalls(mock.calls, 'platform_settings', 'company_id'), [COMPANY_B]);
  } finally { mock.restore(); }

  mock = installDbMock({ companies: [{ data: [
    { id: COMPANY_A, is_default: true, status: 'active' },
    { id: COMPANY_B, is_default: false, status: 'active' },
  ], error: null }] });
  try {
    const res = makeRes();
    await loyalty.getPublicRankSettings({ headers: {}, query: {} }, res);
    assert.equal(res.statusCode, 400);
  } finally { mock.restore(); }
});

test('verifix penalty rate and penalties list read the caller company row', () => {
  const verifix = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'models', 'verifix.js'), 'utf8');
  const penalties = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'models', 'penalties.js'), 'utf8');
  assert.doesNotMatch(verifix, /verifix_settings WHERE id = 1/i);
  assert.doesNotMatch(verifix, /ON CONFLICT \(id\)/);
  assert.match(verifix, /ON CONFLICT \(company_id\)/);
  assert.doesNotMatch(penalties, /verifix_settings where id = 1/i);
  assert.match(penalties, /verifix_settings where company_id = \$1/);
});

test('verifix penalty settings: no company context -> 403, company B writes its own row', async () => {
  const verifix = require('../src/models/verifix');
  const token = bearer('admin_network');
  const pool = installPoolMock((sql) => (/select penalty_per_minute/i.test(sql) ? { rows: [{ penalty_per_minute: 5 }] } : { rows: [] }));
  const originalQuery = postgres.db.query;
  postgres.db.query = (sql, params) => postgres.pool.query(sql, params);
  try {
    const noCompany = makeRes();
    await verifix.penaltySettings({ headers: { authorization: token }, method: 'GET', dbActor: { id: ADMIN_B, role: 'admin_network', branchScope: [] } }, noCompany);
    assert.equal(noCompany.statusCode, 403);

    const res = makeRes();
    await verifix.penaltySettings({
      headers: { authorization: token },
      method: 'PATCH',
      body: { penalty_per_minute: 100 },
      dbActor: { id: ADMIN_B, role: 'admin_network', branchScope: [], companyId: COMPANY_B },
    }, res);
    assert.equal(res.statusCode, 200);
    const insert = pool.calls.find((c) => /INSERT INTO verifix_settings/i.test(c.sql));
    assert.equal(insert.params[1], COMPANY_B);
    const read = pool.calls.find((c) => /SELECT penalty_per_minute/i.test(c.sql));
    assert.deepEqual(read.params, [COMPANY_B]);
  } finally { pool.restore(); postgres.db.query = originalQuery; }
});

test('marketplace settings: list/update target (company_id, key) of the tenant', async () => {
  const settings = require('../src/models/marketplace/settings');
  const pool = installPoolMock(() => ({ rows: [{ key: 'cashback' }] }));
  // Role and company come from the DB (createAdminAuth, Phase 2 M3): an
  // account without a company is refused even with a valid admin token.
  let mock = installDbMock({
    ...staffTables('admin'),
    users: [{ data: { id: ADMIN_B, login: 'b', role: 'admin', branch_id: null, company_id: null }, error: null }],
  });
  try {
    const anonymousTenant = makeRes();
    await settings.list({ headers: { authorization: bearer('admin') } }, anonymousTenant);
    assert.equal(anonymousTenant.statusCode, 403);
    mock.restore();
    mock = installDbMock(staffTables('admin'));

    const res = makeRes();
    await settings.update({
      headers: { authorization: bearer('admin') },
      tenant: { companyId: COMPANY_B },
      params: { key: 'cashback' },
      body: { value: { default_percent: 2 }, company_id: COMPANY_A },
    }, res);
    assert.equal(res.statusCode, 200);
    const insert = pool.calls.find((c) => /insert into platform_settings/.test(c.sql));
    assert.match(insert.sql, /on conflict \(company_id, key\)/);
    assert.equal(insert.params[2], COMPANY_B);
  } finally { pool.restore(); mock.restore(); }
});

test('marketplace profile: legacy client lookups are per company, never by phone alone', () => {
  const profile = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'models', 'marketplace', 'profile.js'), 'utf8');
  assert.match(profile, /where company_id = \$3\s+and regexp_replace/);
  assert.doesNotMatch(profile, /findLegacyClientByPhone\([^,)]+\)/);
  assert.doesNotMatch(profile, /\.eq\('id', 1\)/);
  assert.match(profile, /insert\(\{ company_id: companyId, name: fallbackName, phone \}\)/);
});
