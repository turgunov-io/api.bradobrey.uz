// Single place for JWT verification (MULTI_TENANCY Phase 1 step B1).
//
//   verifyAny(token)              any token signed with JWT_SECRET (staff or
//                                 marketplace); callers check the kind/role.
//   verifyStaffToken(token)       rejects marketplace client tokens.
//   verifyMarketplaceToken(token) accepts only marketplace client tokens.
//   getBearerToken(req)           `Authorization: Bearer <token>` or null.
//
// The algorithm is pinned to HS256 (what jwt.sign uses by default), so a token
// signed with another algorithm, or unsigned, is never accepted. All verify
// functions throw on failure, like jwt.verify; `options.secret` overrides
// JWT_SECRET (tests and injectable guards).
const jwt = require('jsonwebtoken');

const JWT_ALGORITHMS = Object.freeze(['HS256']);
const MARKETPLACE_ROLE = 'marketplace';

function getJwtSecret(secret) {
  const value = secret || process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET is not configured');
  return value;
}

function kindMismatch(message) {
  const error = new Error(message);
  error.code = 'TOKEN_KIND_MISMATCH';
  return error;
}

/**
 * @param {string} token
 * @param {{ secret?: string }} [options]
 * @returns {Record<string, any>} verified claims
 */
function verifyAny(token, { secret } = {}) {
  return jwt.verify(token, getJwtSecret(secret), { algorithms: [...JWT_ALGORITHMS] });
}

const isMarketplaceClaims = (payload) => String(payload?.role || '').trim() === MARKETPLACE_ROLE;

function verifyStaffToken(token, options) {
  const payload = verifyAny(token, options);
  if (isMarketplaceClaims(payload)) throw kindMismatch('Marketplace tokens are not staff tokens');
  return payload;
}

function verifyMarketplaceToken(token, options) {
  const payload = verifyAny(token, options);
  if (!isMarketplaceClaims(payload)) throw kindMismatch('Only marketplace client tokens are accepted');
  return payload;
}

function getBearerToken(req) {
  const header = String(req?.headers?.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

module.exports = {
  JWT_ALGORITHMS,
  MARKETPLACE_ROLE,
  getBearerToken,
  getJwtSecret,
  isMarketplaceClaims,
  verifyAny,
  verifyMarketplaceToken,
  verifyStaffToken,
};
