const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ADVISORY_LOCK_KEY,
  checksumOf,
  loadMigrations,
  parseMigrationFileName,
  planMigrations,
  runMigrations,
  settingsFromEnv,
} = require('../scripts/lib/migrationRunner');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'db', 'migrations');
const silentLogger = { log() {}, warn() {} };

const migration = (version, name, sql = `select ${Number(version)};`) => ({
  version,
  name,
  fileName: `${version}_${name}.sql`,
  sql,
  checksum: checksumOf(sql),
});

function fakeClient({ applied = [], failOn = null } = {}) {
  const calls = [];
  const client = {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql).trim(), params });
      if (failOn && String(sql).includes(failOn)) throw new Error('boom');
      if (/^select version, checksum from schema_migrations/i.test(String(sql).trim())) {
        return { rows: applied };
      }
      return { rows: [] };
    },
  };
  return client;
}

const statements = (client) => client.calls.map((call) => call.sql.split('\n')[0]);

function fakeFs(files) {
  return {
    readdirSync: () => Object.keys(files).map((name) => ({
      name,
      isFile: () => files[name] !== null,
    })),
    readFileSync: (filePath) => files[path.basename(filePath)],
  };
}

test('parseMigrationFileName accepts NNN_snake_name.sql only', () => {
  assert.deepEqual(parseMigrationFileName('001_companies.sql'), {
    version: '001', name: 'companies', fileName: '001_companies.sql',
  });
  assert.equal(parseMigrationFileName('companies.sql'), null);
  assert.equal(parseMigrationFileName('001-companies.sql'), null);
  assert.equal(parseMigrationFileName('001_companies.down.sql'), null);
});

test('loadMigrations sorts numerically, ignores folders and non-migration files', () => {
  const migrations = loadMigrations('/m', fakeFs({
    '010_ten.sql': 'select 10;',
    '002_two.sql': 'select 2;',
    'README.md': 'x',
    down: null,
    deferred: null,
  }));
  assert.deepEqual(migrations.map((m) => m.fileName), ['002_two.sql', '010_ten.sql']);
  assert.equal(migrations[0].checksum, checksumOf('select 2;'));
});

test('loadMigrations rejects duplicate versions', () => {
  assert.throws(
    () => loadMigrations('/m', fakeFs({ '001_a.sql': 'select 1;', '001_b.sql': 'select 1;' })),
    /Duplicate migration version 001/
  );
});

test('loadMigrations rejects files with their own transaction control', () => {
  assert.throws(
    () => loadMigrations('/m', fakeFs({ '001_a.sql': 'begin;\nselect 1;\ncommit;' })),
    /transaction control/
  );
  // plpgsql blocks (begin ... end;) are fine.
  const ok = loadMigrations('/m', fakeFs({ '001_a.sql': 'do $$\nbegin\n  perform 1;\nend;\n$$;' }));
  assert.equal(ok.length, 1);
});

test('planMigrations refuses edited applied migrations', () => {
  const files = [migration('001', 'a', 'select 1;')];
  assert.throws(
    () => planMigrations(files, [{ version: '001', checksum: checksumOf('select 0;') }]),
    /edited after being applied: 001_a\.sql/
  );
});

test('planMigrations reports pending, missing files and out-of-order versions', () => {
  const files = [migration('001', 'a'), migration('002', 'b'), migration('004', 'd')];
  const plan = planMigrations(files, [
    { version: '001', checksum: files[0].checksum },
    { version: '003', checksum: 'x' },
  ]);
  assert.deepEqual(plan.pending.map((m) => m.version), ['002', '004']);
  assert.deepEqual(plan.missingFiles, ['003']);
  assert.deepEqual(plan.outOfOrder.map((m) => m.version), ['002']);
});

test('runMigrations applies each pending file in its own transaction and records it', async () => {
  const files = [migration('001', 'a'), migration('002', 'b')];
  const client = fakeClient({ applied: [{ version: '001', checksum: files[0].checksum }] });

  const result = await runMigrations({
    client,
    migrations: files,
    settings: [{ name: 'app.seed_company_code', value: 'BRADOBREY' }],
    logger: silentLogger,
  });

  assert.deepEqual(result.applied, ['002_b.sql']);
  assert.deepEqual(statements(client), [
    'select pg_advisory_lock(hashtext($1))',
    'create table if not exists schema_migrations (',
    'select version, checksum from schema_migrations order by version',
    'begin',
    'select set_config($1, $2, true)',
    'select set_config($1, $2, true)',
    'select 2;',
    'insert into schema_migrations (version, name, checksum, execution_ms) values ($1, $2, $3, $4)',
    'commit',
    'select pg_advisory_unlock(hashtext($1))',
  ]);
  assert.deepEqual(client.calls[0].params, [ADVISORY_LOCK_KEY]);
  assert.deepEqual(client.calls[4].params, ['lock_timeout', '15s']);
  assert.deepEqual(client.calls[5].params, ['app.seed_company_code', 'BRADOBREY']);
  const insert = client.calls.find((call) => call.sql.startsWith('insert into schema_migrations'));
  assert.deepEqual(insert.params.slice(0, 3), ['002', 'b', files[1].checksum]);
});

test('runMigrations rolls back, stops at the failing file and still unlocks', async () => {
  const files = [migration('001', 'a', 'select 1;'), migration('002', 'b', 'select broken;'), migration('003', 'c')];
  const client = fakeClient({ failOn: 'select broken;' });

  await assert.rejects(
    runMigrations({ client, migrations: files, logger: silentLogger }),
    (error) => error.migration === '002_b.sql' && /002_b\.sql failed: boom/.test(error.message)
  );

  const sqls = statements(client);
  assert.equal(sqls.filter((sql) => sql === 'commit').length, 1, 'only 001 committed');
  assert.ok(sqls.includes('rollback'));
  assert.ok(!sqls.includes('select 3;'), '003 never runs after a failure');
  assert.equal(sqls.at(-1), 'select pg_advisory_unlock(hashtext($1))');
});

test('runMigrations dry run lists pending files without executing them', async () => {
  const files = [migration('001', 'a')];
  const client = fakeClient();
  const result = await runMigrations({ client, migrations: files, dryRun: true, logger: silentLogger });
  assert.deepEqual(result.pending, ['001_a.sql']);
  assert.ok(!statements(client).includes('begin'));
});

test('settingsFromEnv maps only non-empty MIGRATE_* seed variables', () => {
  assert.deepEqual(settingsFromEnv({
    MIGRATE_SEED_COMPANY_CODE: ' BRADOBREY ',
    MIGRATE_SEED_COMPANY_NAME: '',
    MIGRATE_SEED_BARBERSHOP_ID: '00000000-0000-0000-0000-000000000001',
    DATABASE_URL: 'postgres://ignored',
  }), [
    { name: 'app.seed_company_code', value: 'BRADOBREY' },
    { name: 'app.seed_barbershop_id', value: '00000000-0000-0000-0000-000000000001' },
  ]);
});

test('repository migrations load cleanly; the global-unique drop runs last as 007', () => {
  const migrations = loadMigrations(MIGRATIONS_DIR);
  const fileNames = migrations.map((m) => m.fileName);
  assert.deepEqual(fileNames.slice(0, 4), [
    '001_companies.sql',
    '002_tenant_company_id.sql',
    '003_tenant_composite_uniques.sql',
    '004_platform_owner_role.sql',
  ]);
  // Phase 1 step B2 migrations (005 may come from the B2a stream).
  assert.ok(fileNames.includes('006_warehouse_categories_company.sql'));
  // Former deferred/101: runs after the additive 001-006, in the same
  // release as the company-scoped code.
  assert.equal(fileNames.at(-3), '007_drop_global_uniques.sql');
  // Security review H1: per-company kiosk enrollment codes (additive, after 007).
  assert.equal(fileNames.at(-2), '008_company_kiosk_enrollment.sql');
  assert.match(migrations.at(-2).sql, /add column if not exists kiosk_enrollment_code_hash text/i);
  assert.ok(migrations.at(-2).sql.includes("check (kiosk_enrollment_code_hash ~ '^[0-9a-f]{64}$')"));
  // Platform owner accounts: users.created_at (additive; API tolerates its absence).
  assert.equal(fileNames.at(-1), '009_users_created_at.sql');
  assert.match(migrations.at(-1).sql, /add column if not exists created_at timestamptz not null default now\(\)/i);
  assert.ok(!fs.existsSync(path.join(MIGRATIONS_DIR, 'deferred')), 'no deferred migrations left');
  for (const m of migrations) {
    assert.ok(
      fs.existsSync(path.join(MIGRATIONS_DIR, 'down', `${m.version}_${m.name}.down.sql`)),
      `rollback file for ${m.fileName}`
    );
  }
  const additive = migrations.find((m) => m.version === '003').sql;
  assert.doesNotMatch(additive, /drop constraint\s+(if exists\s+)?\w+_(login|phone|code)_key/i);
  const drop = migrations.find((m) => m.version === '007').sql;
  assert.ok(drop.includes("mt_drop_single_column_unique('clients', 'phone')"));
  assert.match(drop, /primary key using index platform_settings_company_key_uidx/);
});

test('002 tenantizes every core tenant table with a guard trigger', () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '002_tenant_company_id.sql'), 'utf8');
  for (const table of [
    'branches', 'users', 'barbers', 'kiosks', 'services', 'service_categories', 'clients',
    'cashback_wallets', 'cashback_transactions', 'cashback_settlements', 'promo_codes',
    'certificates', 'banners', 'kiosk_ad_settings', 'warehouse_positions', 'warehouse_purchases',
    'notifications', 'queue_entries', 'payments', 'finance_snapshots', 'barber_work_schedules',
    'barber_activity_events', 'queue_status_events', 'queue_quality_assessments',
    'employee_branch_access', 'referral_accounts', 'referrals', 'platform_settings',
  ]) {
    assert.match(sql, new RegExp(`mt_tenantize\\('${table}'`), table);
  }
  assert.match(sql, /'skip_if:role=platform_owner'/);
  assert.match(sql, /app\.tenant_strict/);
});
