const DEFAULT_TIMEZONE = 'Asia/Tashkent';

function zonedDateString(date, timeZone = DEFAULT_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function zonedDayStartIsoForDate(localDate, timeZone = DEFAULT_TIMEZONE) {
  const guess = new Date(`${localDate}T00:00:00.000Z`);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(guess).map((part) => [part.type, part.value]));
  const localWallTime = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  const offset = localWallTime - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString();
}

function zonedDayStartIso(date, timeZone = DEFAULT_TIMEZONE) {
  return zonedDayStartIsoForDate(zonedDateString(date, timeZone), timeZone);
}

function nextZonedDayStartIso(date, timeZone = DEFAULT_TIMEZONE) {
  const localDate = zonedDateString(date, timeZone);
  const next = new Date(`${localDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return zonedDayStartIsoForDate(next.toISOString().slice(0, 10), timeZone);
}

module.exports = { DEFAULT_TIMEZONE, zonedDateString, zonedDayStartIso, nextZonedDayStartIso };
