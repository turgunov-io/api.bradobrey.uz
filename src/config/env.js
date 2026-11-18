// Startup environment validation. Called from server.js right after dotenv so
// a misconfigured deploy fails at boot with one clear message instead of on
// the first request. Never logs secret values, only variable names.
const { createPoolConfig } = require('./postgresConfig');

const MIN_JWT_SECRET_LENGTH = 32;

const isBlank = (value) => !String(value || '').trim();

const validateEnv = (env = process.env, { logger = console } = {}) => {
  const problems = [];

  if (isBlank(env.JWT_SECRET)) {
    problems.push('JWT_SECRET is not set');
  }

  // Same resolution order as the pool: DATABASE_URL / POSTGRES_URL /
  // POSTGRES_CONNECTION_STRING, then discrete PG* / POSTGRES_* vars.
  try {
    createPoolConfig(env);
  } catch (error) {
    problems.push(error.message);
  }

  if (problems.length) {
    throw new Error(`Invalid environment configuration:\n- ${problems.join('\n- ')}`);
  }

  // Production-only advisories. Deliberately warnings, not errors, so a
  // running deploy with an older .env keeps starting.
  const warnings = [];
  if (env.NODE_ENV === 'production') {
    if (isBlank(env.KIOSK_SOCKET_SECRET)) {
      warnings.push('KIOSK_SOCKET_SECRET is not set; kiosk socket tickets will be rejected (503)');
    }
    if (isBlank(env.OTP_HASH_SECRET)) {
      warnings.push('OTP_HASH_SECRET is not set; Telegram OTP hashing falls back to JWT_SECRET');
    }
    if (isBlank(env.TRUST_PROXY) || env.TRUST_PROXY === 'false') {
      warnings.push('TRUST_PROXY is not set; behind a reverse proxy all clients share one rate-limit bucket');
    }
    if (String(env.JWT_SECRET).trim().length < MIN_JWT_SECRET_LENGTH) {
      warnings.push(`JWT_SECRET is shorter than ${MIN_JWT_SECRET_LENGTH} characters`);
    }
  }

  warnings.forEach((message) => logger.warn(`[env] ${message}`));
  return { warnings };
};

module.exports = { validateEnv, MIN_JWT_SECRET_LENGTH };
