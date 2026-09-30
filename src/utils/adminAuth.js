const jwt = require('jsonwebtoken');

const ADMIN_ROLES = new Set(['admin_network', 'admin_branch', 'admin', 'merchant']);

function requireAdmin(req, res) {
  const token = String(req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  if (!token) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }

  let payload;
  try {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (_err) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }

  if (!ADMIN_ROLES.has(payload?.role)) {
    res.status(403).json({ error: 'Only admins can manage loyalty settings' });
    return null;
  }
  return payload;
}

module.exports = { ADMIN_ROLES, requireAdmin };
