// Effective timezone of a branch/company (Phase 2 M5).
//
// Single precedence rule, shared with jobs/autoCloseQueue:
//   branches.timezone -> companies.timezone -> DEFAULT_TIMEZONE
// Values that are not IANA zone names (offsets, abbreviations) are skipped;
// normalizeTimezoneInput validates request fields on write (INVALID_TIMEZONE).
//
//   pickTimezone(...candidates)              pure: first valid candidate, else default
//                                            (effectiveTimeZone is an alias)
//   resolveTimezone({ branchId, companyId }, { query | db })
//                                            DB lookup; a branch outside the given
//                                            company is ignored (falls back to the company)
//   branchTimeZone(branchId, opts)           = resolveTimezone({ branchId }, opts)
//   companyTimeZone(companyId, opts)         = resolveTimezone({ companyId }, opts)
//   timezoneOfBranchRow(row, opts)           loaded branch row; queries only if its tz is unset
//   zonedDateKey(value, timeZone)            'YYYY-MM-DD' of an instant in that zone
//   zonedMidnightIso(localDate, timeZone)    '<date>T00:00:00±HH:MM' (local midnight)
const { DEFAULT_TIMEZONE } = require('./timezone');

const formatterCache = new Map();
function formatterFor(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }));
  }
  return formatterCache.get(timeZone);
}

// Phase 2 security fix M1: values reach SQL `at time zone $n`, and Postgres
// reads anything that is not a zone name by its own rules ('+05:00' is POSIX,
// i.e. UTC-5; abbreviations come from its abbreviation table). So only IANA
// Area/Location names (IANA areas only: 'US/Eastern'-style backward links are
// missing from slim tzdata installs), 'UTC' and 'Etc/...' are accepted, and
// Intl must know them. Offsets, abbreviations ('EST', 'GMT') and POSIX
// strings ('EST5EDT') are rejected.
const IANA_AREAS = 'Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc';
const IANA_ZONE_PATTERN = new RegExp(`^(?:${IANA_AREAS})(?:/[A-Za-z0-9_+-]+)+$`, 'i');

/**
 * Canonical spelling of an IANA zone name, or null when not accepted.
 * Case is taken from Intl when it names the same zone; ICU aliases (e.g.
 * Asia/Kolkata -> Asia/Calcutta) are not applied, since Postgres tzdata may
 * lack the legacy name. Postgres matches zone names case-insensitively.
 * @param {unknown} value
 * @returns {string|null}
 */
function canonicalTimeZone(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (text.toUpperCase() === 'UTC') return 'UTC';
  if (!IANA_ZONE_PATTERN.test(text)) return null;
  let resolved;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: text }).resolvedOptions().timeZone;
  } catch (_error) {
    return null;
  }
  return String(resolved).toLowerCase() === text.toLowerCase() ? resolved : text;
}

function isValidTimeZone(value) {
  return canonicalTimeZone(value) !== null;
}

/** First valid IANA timezone among the candidates (canonical case), else DEFAULT_TIMEZONE. */
function pickTimezone(...candidates) {
  for (const candidate of candidates) {
    const canonical = canonicalTimeZone(candidate);
    if (canonical) return canonical;
  }
  return DEFAULT_TIMEZONE;
}

const INVALID_TIMEZONE = Object.freeze({
  code: 'INVALID_TIMEZONE',
  error: 'timezone must be an IANA time zone name (e.g. Asia/Tashkent or UTC)',
});

/**
 * Write-side check for a request `timezone` field.
 * undefined -> { value: undefined } (field not sent), null/blank -> { value: null },
 * valid -> { value: canonical }, anything else -> { error: INVALID_TIMEZONE }.
 */
function normalizeTimezoneInput(value) {
  if (value === undefined) return { value: undefined };
  if (value === null || (typeof value === 'string' && !value.trim())) return { value: null };
  const canonical = canonicalTimeZone(value);
  return canonical ? { value: canonical } : { error: INVALID_TIMEZONE };
}
const effectiveTimeZone = pickTimezone;

// Lazily resolved: config/postgres needs database env at require time.
const defaultQuery = (...args) => require('../config/postgres').pool.query(...args);

/** Accepts `{ query }` (function) or `{ db }` (anything with .query). */
function queryFrom({ query, db } = {}) {
  if (typeof query === 'function') return query;
  if (db && typeof db.query === 'function') return (...args) => db.query(...args);
  return defaultQuery;
}

/**
 * @param {{ branchId?: string|null, companyId?: string|null }} target
 * @param {{ query?: Function, db?: { query: Function } }} [options]
 * @returns {Promise<string>} effective timezone (never null)
 */
async function resolveTimezone({ branchId = null, companyId = null } = {}, options = {}) {
  const query = queryFrom(options);
  if (branchId) {
    const result = await query(
      `select b.timezone, c.timezone as company_timezone
         from branches b
         left join companies c on c.id = b.company_id
        where b.id = $1 and ($2::uuid is null or b.company_id = $2::uuid)
        limit 1`,
      [branchId, companyId || null],
    );
    const row = result?.rows?.[0];
    if (row) return pickTimezone(row.timezone, row.company_timezone);
  }
  if (companyId) {
    const result = await query('select timezone from companies where id = $1 limit 1', [companyId]);
    return pickTimezone(result?.rows?.[0]?.timezone);
  }
  return DEFAULT_TIMEZONE;
}

/** branches.timezone -> companies.timezone -> default. */
const branchTimeZone = (branchId, options) => resolveTimezone({ branchId }, options);

/** companies.timezone -> default. */
const companyTimeZone = (companyId, options) => resolveTimezone({ companyId }, options);

/**
 * Effective timezone of an already-loaded branch row ({ id, timezone, company_id }).
 * No query when the row carries a valid timezone; otherwise the company step.
 */
async function timezoneOfBranchRow(branch, options) {
  const own = canonicalTimeZone(branch?.timezone);
  if (own) return own;
  if (branch?.company_id) return resolveTimezone({ companyId: branch.company_id }, options);
  return resolveTimezone({ branchId: branch?.id || null }, options);
}

function zonedParts(timestamp, timeZone) {
  return Object.fromEntries(
    formatterFor(pickTimezone(timeZone)).formatToParts(timestamp).map((part) => [part.type, part.value]),
  );
}

/** 'YYYY-MM-DD' of `value` (Date, ISO string, ms) in `timeZone`, or null. */
function zonedDateKey(value, timeZone = DEFAULT_TIMEZONE) {
  const timestamp = value instanceof Date ? value.getTime() : (typeof value === 'number' ? value : Date.parse(value));
  if (!Number.isFinite(timestamp)) return null;
  const parts = zonedParts(timestamp, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const pad = (value) => String(value).padStart(2, '0');

/** Local midnight of calendar date `localDate` in `timeZone`, with its UTC offset. */
function zonedMidnightIso(localDate, timeZone = DEFAULT_TIMEZONE) {
  const guess = Date.parse(`${localDate}T00:00:00Z`);
  // Offset of the zone around that midnight (two passes handle DST edges).
  let offsetMinutes = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    const instant = guess - offsetMinutes * 60000;
    const parts = zonedParts(instant, timeZone);
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    offsetMinutes = Math.round((wall - instant) / 60000);
  }
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  return `${localDate}T00:00:00${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

module.exports = {
  DEFAULT_TIMEZONE,
  INVALID_TIMEZONE,
  canonicalTimeZone,
  normalizeTimezoneInput,
  branchTimeZone,
  companyTimeZone,
  effectiveTimeZone,
  isValidTimeZone,
  pickTimezone,
  resolveTimezone,
  timezoneOfBranchRow,
  zonedDateKey,
  zonedMidnightIso,
};
