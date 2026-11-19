// Phase 2 M5: calendar dates are interpreted in the branch/company timezone
// (utils/tenantTimezone resolveTimezone); DEFAULT_TIMEZONE keeps the legacy
// Tashkent (UTC+5) behaviour for callers that pass none.
const { DEFAULT_TIMEZONE, zonedDateKey, zonedMidnightIso } = require('./tenantTimezone');
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseCalendarDate(value) {
  const text = String(value || '').trim();
  if (!CALENDAR_DATE_PATTERN.test(text)) return null;

  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return null;
  return text;
}

function addCalendarDays(value, amount) {
  const parsed = new Date(`${value}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

function normalizeStatisticsDateRange(startValue, endValue, { timeZone = DEFAULT_TIMEZONE } = {}) {
  const startDate = parseCalendarDate(startValue);
  const endDate = parseCalendarDate(endValue);

  if (!startDate || !endDate) {
    return { error: 'start_date and end_date must be valid YYYY-MM-DD dates' };
  }
  if (endDate < startDate) {
    return { error: 'end_date must not be earlier than start_date' };
  }

  return {
    endDate,
    endExclusive: zonedMidnightIso(addCalendarDays(endDate, 1), timeZone),
    startDate,
    startInclusive: zonedMidnightIso(startDate, timeZone),
  };
}

function normalizeDateBound(value, { endExclusive = false, timeZone = DEFAULT_TIMEZONE } = {}) {
  const text = String(value || '').trim();
  const calendarDate = parseCalendarDate(text);
  if (calendarDate) {
    const date = endExclusive ? addCalendarDays(calendarDate, 1) : calendarDate;
    return zonedMidnightIso(date, timeZone);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeOptionalDateRange(startValue, endValue, { timeZone = DEFAULT_TIMEZONE } = {}) {
  if (!startValue && !endValue) return { endExclusive: null, startInclusive: null };

  const startInclusive = startValue ? normalizeDateBound(startValue, { timeZone }) : null;
  const endExclusive = endValue ? normalizeDateBound(endValue, { endExclusive: true, timeZone }) : null;
  if ((startValue && !startInclusive) || (endValue && !endExclusive)) {
    return { error: 'Invalid history date range' };
  }
  if (startInclusive && endExclusive && new Date(startInclusive) >= new Date(endExclusive)) {
    return { error: 'end_date must not be earlier than start_date' };
  }

  return { endExclusive, startInclusive };
}

/** Calendar day of an instant in `timeZone` (default: legacy Asia/Tashkent), or 'unknown'. */
function toZonedDateKey(value, timeZone = DEFAULT_TIMEZONE) {
  return zonedDateKey(value, timeZone) || 'unknown';
}
// Legacy name, kept for callers not yet passing a timezone.
const toTashkentDateKey = (value) => toZonedDateKey(value, DEFAULT_TIMEZONE);

module.exports = {
  addCalendarDays,
  normalizeDateBound,
  normalizeOptionalDateRange,
  normalizeStatisticsDateRange,
  parseCalendarDate,
  toTashkentDateKey,
  toZonedDateKey,
};
