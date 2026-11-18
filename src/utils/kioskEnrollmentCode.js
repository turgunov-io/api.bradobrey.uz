// Per-company kiosk enrollment codes (MULTI_TENANCY 9.7, security review H1).
//
// The plain code is never stored or returned: companies.kiosk_enrollment_code_hash
// holds its SHA-256 hex digest (same scheme as kiosk device tokens), and the
// compare is constant-time. Codes are trimmed on save and on compare.
const crypto = require('crypto');

const MIN_ENROLLMENT_CODE_LENGTH = 8;
const MAX_ENROLLMENT_CODE_LENGTH = 128;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * @param {unknown} value
 * @returns {[string] | [undefined, string]} trimmed code, or an error message
 */
function validateEnrollmentCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  if (code.length < MIN_ENROLLMENT_CODE_LENGTH || code.length > MAX_ENROLLMENT_CODE_LENGTH) {
    return [undefined, `kiosk enrollment code must be ${MIN_ENROLLMENT_CODE_LENGTH}-${MAX_ENROLLMENT_CODE_LENGTH} characters`];
  }
  return [code];
}

/** @param {string} code @returns {string} SHA-256 hex digest */
const hashEnrollmentCode = (code) => crypto.createHash('sha256').update(String(code).trim()).digest('hex');

/**
 * @param {unknown} submitted code sent by the kiosk
 * @param {string|null|undefined} expectedHash stored hash
 * @returns {boolean}
 */
function enrollmentCodeMatches(submitted, expectedHash) {
  if (typeof submitted !== 'string' || !submitted.trim()) return false;
  if (typeof expectedHash !== 'string' || !HASH_PATTERN.test(expectedHash)) return false;
  const actual = Buffer.from(hashEnrollmentCode(submitted), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = {
  MAX_ENROLLMENT_CODE_LENGTH,
  MIN_ENROLLMENT_CODE_LENGTH,
  enrollmentCodeMatches,
  hashEnrollmentCode,
  validateEnrollmentCode,
};
