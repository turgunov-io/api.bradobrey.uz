// Phase 1 step B2a: company-aware database functions (migration 005).
// apply-schema.sh re-runs the base files on every deploy, so the base copies
// must stay identical to the migration or a deploy would silently put the
// global (company-mixing) versions back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const migration = read('db/migrations/005_company_scoped_functions.sql');

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blocks = (sql, signature) => sql.match(new RegExp(
  `create or replace function (?:public\\.)?${escape(signature)}[\\s\\S]*?\\n\\$\\$;\\n`, 'g',
)) || [];

const SHARED = [
  ['db/postgres/marketplace_tz_compliance.sql', 'tenant_setting(p_key text, p_company_id uuid)'],
  ['db/postgres/marketplace_tz_compliance.sql', 'marketplace_loyalty_level(points integer, p_company_id uuid)'],
  ['db/postgres/marketplace_tz_compliance.sql', 'marketplace_loyalty_level(points integer)\n'],
  ['db/postgres/marketplace_tz_compliance.sql', 'apply_marketplace_status_points_from_queue()'],
  ['db/postgres/marketplace_tz_compliance.sql', 'apply_marketplace_referral_bonus_from_queue()'],
  ['db/postgres/marketplace_tz_compliance.sql', 'apply_referral_bonus_from_completed_queue()'],
  ['db/postgres/loyalty_points_reversal.sql', 'apply_marketplace_status_points_from_queue()'],
  ['db/postgres/client_ranks.sql', 'recompute_company_client_ranks(p_company_id uuid)'],
  ['db/postgres/client_ranks.sql', 'recompute_client_rank(_client_id uuid)'],
  ['db/postgres/client_ranks.sql', 'recompute_all_client_ranks()'],
  ['db/postgres/client_ranks.sql', 'on_client_rank_settings_changed()'],
];

test('base schema functions are identical to migration 005', () => {
  for (const [file, signature] of SHARED) {
    const expected = blocks(migration, signature);
    const actual = blocks(read(file), signature);
    assert.equal(expected.length, 1, `005 defines ${signature}`);
    assert.ok(actual.length >= 1, `${file} defines ${signature}`);
    for (const block of actual) assert.equal(block, expected[0], `${file}: ${signature} drifted from 005`);
  }
});

test('migration 005 never matches clients or settings without a company', () => {
  assert.doesNotMatch(migration, /on conflict \(phone\)/);
  assert.doesNotMatch(migration, /on conflict \(key\)/);
  assert.doesNotMatch(migration, /from platform_settings where key/);
  assert.match(migration, /insert into clients \(company_id, name, phone\)/);
  assert.match(migration, /on conflict \(company_id, phone\)/);
  assert.match(migration, /and r\.company_id = new\.company_id/);
  assert.match(migration, /where company_id = new\.company_id\n\s+and regexp_replace/);
  assert.match(migration, /tenant_setting\('referral', new\.company_id\)/);
  assert.match(migration, /tenant_setting\('status_points', new\.company_id\)/);
  assert.match(migration, /where company_id = v_company_id/);
});

test('base seeds no longer depend on the global platform_settings key', () => {
  for (const file of ['db/postgres/marketplace_tz_compliance.sql', 'db/postgres/loyalty_points_reversal.sql']) {
    const sql = read(file);
    assert.doesNotMatch(sql, /on conflict \(key\)/, file);
    assert.doesNotMatch(sql, /\(select value from platform_settings where key = '[a-z_]+'\)/, file);
  }
});

test('base seeds set company_id explicitly for the default company (no trigger fallback)', () => {
  const seeds = {
    'db/postgres/client_ranks.sql': 'client_rank_settings',
    'db/postgres/kiosk_ads.sql': 'kiosk_ad_settings',
    'db/postgres/verifix.sql': 'verifix_settings',
    'db/postgres/loyalty_points_reversal.sql': 'platform_settings',
    'db/postgres/marketplace_tz_compliance.sql': 'platform_settings',
  };
  for (const [file, table] of Object.entries(seeds)) {
    const sql = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '..', file), 'utf8');
    assert.ok(sql.includes(`insert into ${table} (company_id`), file);
    assert.match(sql, /companies c[\s\S]{0,120}where c\.is_default/, file);
    // Fresh database (before 001-003): legacy seed path still present.
    assert.match(sql, /information_schema\.columns/, file);
  }
});
