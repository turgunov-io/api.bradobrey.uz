const pad2 = (n) => String(n).padStart(2, '0');

const getZonedParts = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
};

const getZonedDateString = (date, timeZone) => {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
};

const getZonedWeekdayIndex = (date, timeZone) => {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[weekday] ?? null;
};

const parseHHMM = (timeText) => {
  if (!timeText) return null;
  const m = String(timeText).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
};

// Convert "local date + time in a timezone" -> JS Date (UTC instant).
// Works without external deps by iterating to account for timezone offsets / DST.
const zonedDateTimeToUtc = ({ dateStr, timeStr, timeZone }) => {
  const dateMatch = String(dateStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const time = parseHHMM(timeStr);
  if (!dateMatch || !time) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);

  // Initial guess: treat local time as UTC.
  let guess = new Date(Date.UTC(year, month - 1, day, time.hours, time.minutes, 0));

  // One or two iterations are enough for timezone offset adjustment.
  for (let i = 0; i < 2; i += 1) {
    const parts = getZonedParts(guess, timeZone);
    const desiredUtcLike = Date.UTC(year, month - 1, day, time.hours, time.minutes, 0);
    const actualUtcLike = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
    const diffMinutes = Math.trunc((desiredUtcLike - actualUtcLike) / (60 * 1000));

    if (!diffMinutes) break;
    guess = new Date(guess.getTime() + diffMinutes * 60 * 1000);
  }

  return guess;
};

const addDaysToDateString = (dateStr, days) => {
  const m = String(dateStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const base = Date.UTC(year, month - 1, day, 0, 0, 0);
  const next = new Date(base + Number(days || 0) * 24 * 60 * 60 * 1000);
  const y = next.getUTCFullYear();
  const mo = next.getUTCMonth() + 1;
  const d = next.getUTCDate();
  return `${y}-${pad2(mo)}-${pad2(d)}`;
};

module.exports = {
  getZonedParts,
  getZonedDateString,
  getZonedWeekdayIndex,
  parseHHMM,
  zonedDateTimeToUtc,
  addDaysToDateString,
};
