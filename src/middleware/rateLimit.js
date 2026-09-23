const buckets = new Map();

function rateLimit({ windowMs, max, keyPrefix }) {
  return (req, res, next) => {
    const identity = `${keyPrefix}:${req.ip || req.headers['x-forwarded-for'] || 'unknown'}`;
    const now = Date.now();
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
