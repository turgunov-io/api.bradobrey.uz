const jwt = require('jsonwebtoken');

const ensureSecret = () => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set');
  }
};

const signToken = (payload, options = {}) => {
  ensureSecret();
  const expiresIn = options.expiresIn || process.env.JWT_EXPIRES_IN || '8h';
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
};

const verifyToken = (token) => {
  ensureSecret();
  return jwt.verify(token, process.env.JWT_SECRET);
};

module.exports = { signToken, verifyToken };
