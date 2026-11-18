#!/usr/bin/env node
// Apply pending db/migrations/NNN_*.sql files (see scripts/lib/migrationRunner.js).
//
//   npm run migrate              apply all pending migrations
//   npm run migrate -- --dry-run list pending migrations only
//
// Uses the same connection env as the API (DATABASE_URL or PG* vars, .env).
// Run scripts/apply-schema.sh (base schema) before the first migration.
// Optional seed settings: MIGRATE_SEED_COMPANY_CODE, MIGRATE_SEED_COMPANY_NAME,
// MIGRATE_SEED_BARBERSHOP_ID, MIGRATE_ALLOW_BARBERSHOP_SPLIT, MIGRATE_LOCK_TIMEOUT.

require('dotenv').config();

const path = require('node:path');
const { Client } = require('pg');
const { createPoolConfig } = require('../src/config/postgresConfig');
const { loadMigrations, runMigrations, settingsFromEnv } = require('./lib/migrationRunner');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'db', 'migrations');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const migrations = loadMigrations(MIGRATIONS_DIR);
  const { max: _max, idleTimeoutMillis: _idle, ...clientConfig } = createPoolConfig(process.env);
  const client = new Client(clientConfig);
  // Migrations report skipped (absent) tables via RAISE NOTICE.
  client.on('notice', (notice) => console.log(`[migrate] notice: ${notice.message}`));

  await client.connect();
  try {
    await runMigrations({
      client,
      migrations,
      settings: settingsFromEnv(process.env),
      dryRun,
      lockTimeout: process.env.MIGRATE_LOCK_TIMEOUT || undefined,
    });
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[migrate] ${error.message}`);
  if (error.cause?.detail) console.error(`[migrate] detail: ${error.cause.detail}`);
  if (error.cause?.where) console.error(`[migrate] where: ${error.cause.where}`);
  process.exitCode = 1;
});
