const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.resolve(__dirname, '..', 'db', 'postgres', 'marketplace_tz_compliance.sql'),
  'utf8',
);

test('marketplace migration preserves the active-booking and idempotency invariants', () => {
  assert.match(migration, /marketplace_bookings_active_client_uidx/);
  assert.match(migration, /where status = 'ACTIVE'/);
  assert.match(migration, /marketplace_bookings_request_uidx/);
  assert.match(migration, /marketplace_idempotency_requests/);
  assert.match(migration, /unique \(referral_id, booking_id\)/);
});

test('marketplace migration keeps wallet and status-point ledgers separate', () => {
  assert.match(migration, /create table if not exists status_point_transactions/);
  assert.match(migration, /alter table cashback_transactions add column if not exists request_id/);
  assert.match(migration, /create table if not exists cashback_reconciliation_alerts/);
  assert.match(migration, /status_point_queue_kind_uidx/);
});

test('marketplace migration configures queue synchronization and platform limits', () => {
  assert.match(migration, /create or replace function sync_marketplace_booking_from_queue/);
  assert.match(migration, /create or replace function apply_marketplace_status_points_from_queue/);
  assert.match(migration, /create or replace function apply_marketplace_referral_bonus_from_queue/);
  assert.match(migration, /create trigger marketplace_booking_queue_sync/);
  assert.match(migration, /create trigger marketplace_status_points_queue_sync/);
  assert.match(migration, /ALMOST_YOUR_TURN/);
  assert.match(migration, /max_persons.*4/);
  assert.match(migration, /max_services_per_person.*3/);
  assert.match(migration, /max_duration_minutes.*180/);
  assert.match(migration, /cancel_cooldown_minutes.*15/);
  assert.match(migration, /no_show_block_threshold.*5/);
});
