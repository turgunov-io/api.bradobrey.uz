require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/postgres');

const migrationPath = path.resolve(__dirname, '..', 'db', 'postgres', 'marketplace_tz_compliance.sql');
const lockKey = 'bradobrey-marketplace-tz-compliance-v1';

const REQUIRED_TABLES = [
  'platform_settings',
  'marketplace_bookings',
  'marketplace_booking_persons',
  'marketplace_booking_person_services',
  'marketplace_idempotency_requests',
  'marketplace_notifications',
  'marketplace_push_tokens',
  'marketplace_fraud_alerts',
  'cashback_settlements',
  'cashback_reconciliation_alerts',
  'cashback_wallets',
  'cashback_transactions',
  'referral_transactions',
];

const REQUIRED_INDEXES = [
  'marketplace_bookings_active_client_uidx',
  'marketplace_bookings_request_uidx',
  'status_point_queue_kind_uidx',
  'referral_transactions_referral_id_booking_id_key',
  'cashback_reconciliation_open_client_uidx',
  'idx_cashback_transactions_request_id',
  'idx_cashback_transactions_reversal_kind',
];

async function verify(client) {
  const tables = await client.query(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema()
        and c.relkind in ('r', 'p')
        and c.relname = any($1::text[])`,
    [REQUIRED_TABLES],
  );
  const tableSet = new Set(tables.rows.map((row) => row.relname));
  const missingTables = REQUIRED_TABLES.filter((name) => !tableSet.has(name));

  const indexes = await client.query(
    `select indexname from pg_indexes
      where schemaname = current_schema() and indexname = any($1::text[])`,
    [REQUIRED_INDEXES],
  );
  const indexSet = new Set(indexes.rows.map((row) => row.indexname));
  const missingIndexes = REQUIRED_INDEXES.filter((name) => !indexSet.has(name));

  if (missingTables.length || missingIndexes.length) {
    throw new Error(`Migration preflight failed: missing tables=${missingTables.join(',')}; indexes=${missingIndexes.join(',')}`);
  }
  return { tables: REQUIRED_TABLES.length, indexes: REQUIRED_INDEXES.length };
}

async function main() {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [lockKey]);
    await client.query(sql);
    const verified = await verify(client);
    await client.query('commit');
    console.log(`Marketplace migration applied and verified: ${verified.tables} tables, ${verified.indexes} indexes.`);
  } catch (error) {
    try { await client.query('rollback'); } catch (_) { /* no-op */ }
    console.error(`Marketplace migration failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Marketplace migration failed: ${error.message}`);
  process.exitCode = 1;
});
