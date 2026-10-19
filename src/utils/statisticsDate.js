const TIMEZONE_OFFSET = '+05:00';
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

function normalizeStatisticsDateRange(startValue, endValue) {
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
    endExclusive: `${addCalendarDays(endDate, 1)}T00:00:00${TIMEZONE_OFFSET}`,
    startDate,
    startInclusive: `${startDate}T00:00:00${TIMEZONE_OFFSET}`,
  };
}

function normalizeDateBound(value, { endExclusive = false } = {}) {
  const text = String(value || '').trim();
  const calendarDate = parseCalendarDate(text);
  if (calendarDate) {
    const date = endExclusive ? addCalendarDays(calendarDate, 1) : calendarDate;
    return `${date}T00:00:00${TIMEZONE_OFFSET}`;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeOptionalDateRange(startValue, endValue) {
  if (!startValue && !endValue) return { endExclusive: null, startInclusive: null };

  const startInclusive = startValue ? normalizeDateBound(startValue) : null;
  const endExclusive = endValue ? normalizeDateBound(endValue, { endExclusive: true }) : null;
  if ((startValue && !startInclusive) || (endValue && !endExclusive)) {
    return { error: 'Invalid history date range' };
  }
  if (startInclusive && endExclusive && new Date(startInclusive) >= new Date(endExclusive)) {
    return { error: 'end_date must not be earlier than start_date' };
  }

  return { endExclusive, startInclusive };
}

function toTashkentDateKey(value) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return 'unknown';

  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
  }).formatToParts(timestamp);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : 'unknown';
}

module.exports = {
  addCalendarDays,
  normalizeDateBound,
  normalizeOptionalDateRange,
  normalizeStatisticsDateRange,
  parseCalendarDate,
  toTashkentDateKey,
};
