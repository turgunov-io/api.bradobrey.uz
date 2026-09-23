const crypto = require('crypto');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

function requestId(req) {
  const incoming = String(req.headers['x-request-id'] || '');
  return REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
}

/**
 * Small dependency-free baseline for API responses. A full CSP is intentionally
 * not set here because this process also serves uploaded images and legacy
 * integrations; CSP belongs at the web frontend/reverse-proxy boundary.
 */
function securityHeaders(req, res, next) {
  const id = requestId(req);
  req.requestId = id;
  res.set('X-Request-Id', id);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.set('Cross-Origin-Resource-Policy', 'same-site');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Cache-Control', 'no-store');

  if (process.env.NODE_ENV === 'production' && process.env.DISABLE_HSTS !== 'true') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

module.exports = { securityHeaders };
