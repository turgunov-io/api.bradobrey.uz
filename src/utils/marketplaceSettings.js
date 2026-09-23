const ALLOWED_KEYS = new Set([
  'booking_limits',
  'anti_fraud',
  'status_points',
  'loyalty_levels',
  'referral',
]);

function validateValue(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'value must be a JSON object';
  }
  if (key === 'booking_limits') {
    const fields = ['max_persons', 'max_services_per_person', 'max_duration_minutes', 'max_daily_bookings'];
    if (fields.some((field) => !Number.isInteger(Number(value[field])) || Number(value[field]) <= 0)) {
      return 'booking_limits values must be positive integers';
    }
  }
  if (key === 'anti_fraud') {
    const fields = ['cancel_cooldown_minutes', 'cancel_block_threshold', 'no_show_block_threshold', 'block_hours'];
    if (fields.some((field) => !Number.isInteger(Number(value[field])) || Number(value[field]) <= 0)) {
      return 'anti_fraud values must be positive integers';
    }
  }
  if (key === 'referral') {
    if (Number(value.expiry_days) <= 0 || Number(value.daily_limit) <= 0 || Number(value.bonus_percent) < 0) {
      return 'referral values are invalid';
    }
  }
  if (key === 'loyalty_levels' && Object.keys(value).length === 0) {
    return 'loyalty_levels must not be empty';
  }
  return null;
}

module.exports = { ALLOWED_KEYS, validateValue };
