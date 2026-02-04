const { verifyToken } = require('../utils/jwt');

const authenticate = (requiredRoles = []) => (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.replace(/Bearer\s+/i, '').trim();

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const payload = verifyToken(token);
    req.user = {
      id: payload.sub,
      login: payload.login,
      role: payload.role,
      branchId: payload.branchId,
      barberId: payload.barberId || null,
    };

    if (requiredRoles.length && !requiredRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const authenticateBarber = authenticate(['barber']);

module.exports = { authenticate, authenticateBarber };
