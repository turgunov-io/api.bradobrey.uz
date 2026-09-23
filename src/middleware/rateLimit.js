const buckets = new Map();
const jwt = require('jsonwebtoken');

const requestIdentity = (req) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) {
    try {
      const payload = jwt.decode(header.slice(7));
      const subject = payload?.sub || payload?.id;
      if (subject) return String(subject);
    } catch (_) {
      // Authentication middleware remains authoritative; rate limiting falls
      // back to the network identity for malformed tokens.
    }
  }
  return String(ip);
};

function rateLimit({ windowMs, max, keyPrefix }) {
  return (req, res, next) => {
    const identity = `${keyPrefix}:${requestIdentity(req)}`;
    const now = Date.now();
    if (buckets.size > 10000) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
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
