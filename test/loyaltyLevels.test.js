const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_LOYALTY_LEVELS, resolveLoyaltyLevel, validateLoyaltyLevels } = require('../src/utils/loyaltyLevels');

test('loyalty status is calculated from backend point thresholds', () => {
  assert.equal(resolveLoyaltyLevel(0, DEFAULT_LOYALTY_LEVELS).name, 'NONE');
  assert.equal(resolveLoyaltyLevel(100, DEFAULT_LOYALTY_LEVELS).name, 'BRONZE');
  assert.equal(resolveLoyaltyLevel(999, DEFAULT_LOYALTY_LEVELS).name, 'SILVER');
  assert.equal(resolveLoyaltyLevel(1500, DEFAULT_LOYALTY_LEVELS).name, 'GOLD');
  assert.equal(resolveLoyaltyLevel(-10, DEFAULT_LOYALTY_LEVELS).name, 'NONE');
});

test('loyalty settings accept increasing non-negative thresholds and editable names', () => {
  const result = validateLoyaltyLevels({
    Guest: { min_points: 0, cashback_percent: 0 },
    Silver: { min_points: 100, cashback_percent: 1.5 },
    Gold: { min_points: 500, cashback_percent: 2 },
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(Object.keys(result.value), ['Guest', 'Silver', 'Gold']);
});

test('loyalty settings reject negative, repeated, overlapping, and malformed thresholds', () => {
  const validBase = { Guest: { min_points: 0 }, Silver: { min_points: 100 } };
  assert.match(validateLoyaltyLevels({ Guest: { min_points: -1 } }).error, /non-negative/);
  assert.match(validateLoyaltyLevels({ Guest: { min_points: 0 }, Silver: { min_points: 0 } }).error, /above/);
  assert.match(validateLoyaltyLevels({ Guest: { min_points: 1 }, Silver: { min_points: 100 } }).error, /start at 0/);
  assert.match(validateLoyaltyLevels({ ...validBase, silver: { min_points: 200 } }).error, /unique/);
  assert.match(validateLoyaltyLevels({ Guest: { min_points: 0 }, Silver: { min_points: 100.5 } }).error, /integer/);
  assert.match(validateLoyaltyLevels({ Guest: { min_points: 0, cashback_percent: 101 } }).error, /cashback_percent/);
  assert.match(validateLoyaltyLevels({ Guest: { min_points: 0, cancel_penalty_points: -1 } }).error, /cancel_penalty_points/);
  assert.match(validateLoyaltyLevels({ Guest: { min_points: 0, no_show_penalty_points: 1.5 } }).error, /no_show_penalty_points/);
});

test('each rank retains its own non-negative cancellation and no-show deductions', () => {
  const result = validateLoyaltyLevels({
    Guest: { min_points: 0, cancel_penalty_points: 5, no_show_penalty_points: 20 },
    Silver: { min_points: 100, cancel_penalty_points: 15, no_show_penalty_points: 30 },
    Gold: { min_points: 500, cancel_penalty_points: 25, no_show_penalty_points: 50 },
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value.Silver, {
    min_points: 100, cashback_percent: 0, cancel_penalty_points: 15, no_show_penalty_points: 30,
  });
});

test('order point reversals are unique, clamped, and limited to previously earned points', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const migration = fs.readFileSync(path.resolve(__dirname, '../db/postgres/loyalty_points_reversal.sql'), 'utf8');
  assert.match(migration, /if new\.status = 'completed' then/);
  assert.match(migration, /status_points = status_points \+ points_amount/);
  assert.match(migration, /on conflict \(queue_entry_id, kind\).*do nothing/s);
  assert.match(migration, /old\.status = 'completed' and new\.status in \('cancelled', 'rejected', 'no_show', 'not_in_time'\)/);
  assert.match(migration, /where queue_entry_id = new\.id and kind = 'EARN'/);
  assert.match(migration, /'REVERSAL', -earned_points/);
  assert.match(migration, /COMPLETED_SERVICE_CANCELLED_BACKFILL/);
  assert.match(migration, /on conflict \(queue_entry_id, kind\).*do nothing/s);
  assert.match(migration, /status_points = greatest\(0, status_points - earned_points\)/);
  assert.match(migration, /marketplace_loyalty_level\(status_points\)/);
  assert.match(migration, /no_show_penalty_points/);
  assert.match(migration, /cancel_penalty_points/);
  assert.match(migration, /where queue_entry_id = new\.id and kind = 'EARN'/);
  const cancellationHandler = fs.readFileSync(path.resolve(__dirname, '../src/models/marketplace/compliance.js'), 'utf8');
  assert.match(cancellationHandler, /rankSettings\.cancel_penalty_points/);
  assert.match(cancellationHandler, /status_points = greatest\(0, status_points \+ \$1\)/);
  assert.match(cancellationHandler, /on conflict \(booking_id, kind\).*do nothing/s);
});
