const ALLOWED_KEYS = new Set([
  'booking_limits',
  'anti_fraud',
  'status_points',
  'loyalty_levels',
  'referral',
  'cashback',
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
  if (key === 'cashback') {
    const percent = Number(value.default_percent);
    const promotionPercent = value.promotion_percent === null || value.promotion_percent === undefined
      ? null
      : Number(value.promotion_percent);
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return 'default_percent must be between 0 and 100';
    }
    if (promotionPercent !== null && (!Number.isFinite(promotionPercent) || promotionPercent < 0 || promotionPercent > 100)) {
      return 'promotion_percent must be between 0 and 100';
    }
    const start = value.promotion_start_date || null;
    const end = value.promotion_end_date || null;
    if ((start && !datePattern.test(String(start))) || (end && !datePattern.test(String(end)))) {
      return 'promotion dates must use YYYY-MM-DD';
    }
    if ((start && !end) || (!start && end)) {
      return 'promotion_start_date and promotion_end_date must be provided together';
    }
    if (start && end && String(start) > String(end)) {
      return 'promotion_end_date must be on or after promotion_start_date';
    }
  }
  if (key === 'loyalty_levels' && Object.keys(value).length === 0) {
    return 'loyalty_levels must not be empty';
  }
  return null;
}

module.exports = { ALLOWED_KEYS, validateValue };
