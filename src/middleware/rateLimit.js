const buckets = new Map();
const MAX_BUCKETS = 10000;
const { verifyAny } = require('../utils/authToken');

const networkIdentity = (req) => String(req.ip || req.headers['x-forwarded-for'] || 'unknown');

const requestIdentity = (req, keyBy) => {
  if (keyBy === 'ip') return networkIdentity(req);

  const header = String(req.headers.authorization || '');
  const secret = process.env.JWT_SECRET;
  if (header.startsWith('Bearer ') && secret) {
    try {
      // Only a signature-verified subject may own a bucket; jwt.decode would
      // let a client mint a fresh subject per request and bypass the limit.
      const payload = verifyAny(header.slice(7), { secret: secret });
      const subject = payload?.sub || payload?.id;
      if (subject) return `sub:${subject}`;
    } catch (_) {
      // Authentication middleware remains authoritative; rate limiting falls
      // back to the network identity for invalid or expired tokens.
    }
  }
  return networkIdentity(req);
};

// keyBy: 'auto' (default) uses the verified JWT subject when present, else IP;
// 'ip' always keys by network identity (for unauthenticated endpoints).
function rateLimit({ windowMs, max, keyPrefix, keyBy = 'auto' }) {
  return (req, res, next) => {
    const identity = `${keyPrefix}:${requestIdentity(req, keyBy)}`;
    const now = Date.now();
    if (buckets.size > MAX_BUCKETS) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      // Hard cap: spoofed identities must not grow memory without bound.
      // Map iteration is insertion order, so this evicts the oldest buckets.
      for (const key of buckets.keys()) {
        if (buckets.size <= MAX_BUCKETS) break;
        buckets.delete(key);
      }
    }
    const current = buckets.get(identity);
    if (!current || current.resetAt <= now) {
      buckets.set(identity, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (current.count >= max) {
      res.set('Retry-After', Math.ceil((current.resetAt - now) / 1000));
      res.status(429).json({ error: 'RATE_LIMITED' });
      return;
    }
    current.count += 1;
    next();
  };
}

module.exports = { rateLimit };
