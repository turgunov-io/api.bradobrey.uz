const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const enabled = process.env.MARKETPLACE_INTEGRATION === '1';

test('PostgreSQL marketplace migration is applied and locked safely', { skip: !enabled }, async () => {
  const connectionString = process.env.MARKETPLACE_DATABASE_URL || process.env.DATABASE_URL;
  assert.ok(connectionString, 'Set MARKETPLACE_DATABASE_URL or DATABASE_URL');

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    const requiredTables = [
      'platform_settings',
      'marketplace_bookings',
      'marketplace_booking_persons',
      'marketplace_booking_person_services',
      'marketplace_idempotency_requests',
      'marketplace_notifications',
      'marketplace_push_tokens',
      'marketplace_fraud_alerts',
      'status_point_transactions',
      'cashback_reconciliation_alerts',
    ];
    const tables = await client.query(
      `select table_name from information_schema.tables
        where table_schema = current_schema() and table_name = any($1::text[])`,
      [requiredTables],
    );
    assert.deepEqual(
      new Set(tables.rows.map((row) => row.table_name)),
      new Set(requiredTables),
    );

    const indexes = await client.query(
      `select indexname from pg_indexes
        where schemaname = current_schema()
          and indexname = any($1::text[])`,
      [[
        'marketplace_bookings_active_client_uidx',
        'marketplace_bookings_request_uidx',
        'status_point_queue_kind_uidx',
        'cashback_reconciliation_open_client_uidx',
      ]],
    );
    assert.equal(indexes.rowCount, 4);

    await client.query('begin');
    const lock = await client.query(
      `select pg_try_advisory_xact_lock(hashtext('bradobrey-marketplace-tz-compliance-v1')) as acquired`,
    );
    assert.equal(lock.rows[0].acquired, true);
    await client.query('rollback');
  } finally {
    client.release();
    await pool.end();
  }
});

