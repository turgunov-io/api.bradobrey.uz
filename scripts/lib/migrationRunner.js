// Numbered SQL migration runner (MULTI_TENANCY Phase 1).
//
// Files: db/migrations/NNN_snake_name.sql (top level only; `down/` and
// `deferred/` sub-folders are never executed). Each pending file runs in its
// own transaction together with the insert into `schema_migrations`, so a
// failed migration leaves no trace and stops the run. An advisory lock keeps
// two deploys from migrating concurrently.
//
// The base idempotent schema in db/postgres/*.sql (scripts/apply-schema.sh)
// must be applied first; migrations build on top of it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_FILE_PATTERN = /^(\d{3,})_([a-z0-9_]+)\.sql$/;
// Transaction control inside a file would break the per-file transaction.
// (`end;` is deliberately not matched: it closes every plpgsql block.)
const TRANSACTION_CONTROL_PATTERN = /^\s*(begin|start\s+transaction|commit|rollback)\s*;/im;
const ADVISORY_LOCK_KEY = 'bradobrey:schema_migrations';
const DEFAULT_LOCK_TIMEOUT = '15s';

// Env var -> session setting read by migrations via current_setting(name, true).
const SETTING_ENV_MAP = Object.freeze({
  MIGRATE_SEED_COMPANY_CODE: 'app.seed_company_code',
  MIGRATE_SEED_COMPANY_NAME: 'app.seed_company_name',
  MIGRATE_SEED_BARBERSHOP_ID: 'app.seed_barbershop_id',
  MIGRATE_ALLOW_BARBERSHOP_SPLIT: 'app.allow_barbershop_split',
});

const CREATE_MIGRATIONS_TABLE_SQL = `create table if not exists schema_migrations (
  version text primary key,
  name text not null,
  checksum text not null,
  execution_ms integer,
  applied_at timestamptz not null default now()
)`;

const checksumOf = (sql) => crypto.createHash('sha256').update(sql, 'utf8').digest('hex');

const parseMigrationFileName = (fileName) => {
  const match = MIGRATION_FILE_PATTERN.exec(fileName);
  if (!match) return null;
  return { version: match[1], name: match[2], fileName };
};

const loadMigrations = (directory, fsImpl = fs) => {
  const entries = fsImpl.readdirSync(directory, { withFileTypes: true });
  const migrations = [];
  const seenVersions = new Map();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseMigrationFileName(entry.name);
    if (!parsed) continue;

    if (seenVersions.has(parsed.version)) {
      throw new Error(
        `Duplicate migration version ${parsed.version}: ${seenVersions.get(parsed.version)} and ${entry.name}`
      );
    }
    seenVersions.set(parsed.version, entry.name);

    const sql = fsImpl.readFileSync(path.join(directory, entry.name), 'utf8');
    if (TRANSACTION_CONTROL_PATTERN.test(sql)) {
      throw new Error(
        `Migration ${entry.name} contains transaction control (BEGIN/COMMIT/ROLLBACK); the runner wraps each file in its own transaction`
      );
    }

    migrations.push({ ...parsed, sql, checksum: checksumOf(sql) });
  }

  return migrations.sort((a, b) => Number(a.version) - Number(b.version));
};

const settingsFromEnv = (env = process.env) => Object.entries(SETTING_ENV_MAP)
  .filter(([envName]) => typeof env[envName] === 'string' && env[envName].trim() !== '')
  .map(([envName, setting]) => ({ name: setting, value: env[envName].trim() }));

// Compares files with the applied ledger. Throws on edited or missing history.
const planMigrations = (migrations, appliedRows) => {
  const applied = new Map(appliedRows.map((row) => [String(row.version), row]));
  const known = new Set(migrations.map((migration) => migration.version));

  const changed = migrations.filter((migration) => {
    const row = applied.get(migration.version);
    return row && row.checksum !== migration.checksum;
  });
  if (changed.length) {
    throw new Error(
      `Applied migrations were edited after being applied: ${changed.map((m) => m.fileName).join(', ')}. `
      + 'Add a new migration instead of changing an applied one.'
    );
  }

  const missingFiles = [...applied.keys()].filter((version) => !known.has(version));
  const pending = migrations.filter((migration) => !applied.has(migration.version));
  const maxApplied = Math.max(0, ...[...applied.keys()].map(Number).filter(Number.isFinite));
  const outOfOrder = pending.filter((migration) => Number(migration.version) < maxApplied);

  return { pending, missingFiles, outOfOrder };
};

const rollbackQuietly = async (client) => {
  try {
    await client.query('rollback');
  } catch (_error) {
    // The original error is more useful than a failed rollback.
  }
};

const applyMigration = async (client, migration, { settings, lockTimeout }) => {
  const startedAt = Date.now();
  await client.query('begin');
  try {
    await client.query('select set_config($1, $2, true)', ['lock_timeout', lockTimeout]);
    for (const setting of settings) {
      await client.query('select set_config($1, $2, true)', [setting.name, setting.value]);
    }
    await client.query(migration.sql);
    const executionMs = Date.now() - startedAt;
    await client.query(
      'insert into schema_migrations (version, name, checksum, execution_ms) values ($1, $2, $3, $4)',
      [migration.version, migration.name, migration.checksum, executionMs]
    );
    await client.query('commit');
    return executionMs;
  } catch (error) {
    await rollbackQuietly(client);
    const wrapped = new Error(`Migration ${migration.fileName} failed: ${error.message}`);
    wrapped.cause = error;
    wrapped.migration = migration.fileName;
    throw wrapped;
  }
};

const runMigrations = async ({
  client,
  migrations,
  settings = [],
  dryRun = false,
  lockTimeout = DEFAULT_LOCK_TIMEOUT,
  logger = console,
}) => {
  if (!client || typeof client.query !== 'function') throw new Error('runMigrations requires a pg client');

  await client.query('select pg_advisory_lock(hashtext($1))', [ADVISORY_LOCK_KEY]);
  try {
    await client.query(CREATE_MIGRATIONS_TABLE_SQL);
    const appliedResult = await client.query('select version, checksum from schema_migrations order by version');
    const { pending, missingFiles, outOfOrder } = planMigrations(migrations, appliedResult.rows || []);

    if (missingFiles.length) {
      logger.warn(`[migrate] applied versions without a file: ${missingFiles.join(', ')}`);
    }
    if (outOfOrder.length) {
      logger.warn(`[migrate] applying older versions after newer ones: ${outOfOrder.map((m) => m.fileName).join(', ')}`);
    }
    if (!pending.length) {
      logger.log('[migrate] up to date');
      return { applied: [], pending: [] };
    }
    if (dryRun) {
      pending.forEach((migration) => logger.log(`[migrate] pending ${migration.fileName}`));
      return { applied: [], pending: pending.map((m) => m.fileName) };
    }

    const applied = [];
    for (const migration of pending) {
      logger.log(`[migrate] applying ${migration.fileName}`);
      const executionMs = await applyMigration(client, migration, { settings, lockTimeout });
      logger.log(`[migrate] applied ${migration.fileName} in ${executionMs} ms`);
      applied.push(migration.fileName);
    }
    return { applied, pending: [] };
  } finally {
    await client.query('select pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_KEY]);
  }
};

module.exports = {
  ADVISORY_LOCK_KEY,
  CREATE_MIGRATIONS_TABLE_SQL,
  MIGRATION_FILE_PATTERN,
  SETTING_ENV_MAP,
  checksumOf,
  loadMigrations,
  parseMigrationFileName,
  planMigrations,
  runMigrations,
  settingsFromEnv,
};
