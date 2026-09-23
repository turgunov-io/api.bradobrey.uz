const test = require('node:test');
const assert = require('node:assert/strict');

const { ALLOWED_KEYS, validateValue } = require('../src/utils/marketplaceSettings');

test('marketplace settings expose only supported platform keys', () => {
  assert.deepEqual([...ALLOWED_KEYS].sort(), [
    'anti_fraud',
    'booking_limits',
    'loyalty_levels',
    'referral',
    'status_points',
  ]);
});

test('marketplace settings validate booking and anti-fraud limits', () => {
  assert.equal(validateValue('booking_limits', {
    max_persons: 4,
    max_services_per_person: 3,
    max_duration_minutes: 180,
    max_daily_bookings: 5,
  }), null);
  assert.match(
    validateValue('booking_limits', { max_persons: 0 }),
    /positive integers/,
  );
  assert.equal(validateValue('anti_fraud', {
    cancel_cooldown_minutes: 15,
    cancel_block_threshold: 3,
    no_show_block_threshold: 5,
    block_hours: 24,
  }), null);
});

test('marketplace settings reject invalid referral and non-object values', () => {
  assert.match(validateValue('referral', null), /JSON object/);
  assert.match(validateValue('referral', {
    expiry_days: 0,
    daily_limit: 10,
    bonus_percent: 1,
  }), /invalid/);
});
