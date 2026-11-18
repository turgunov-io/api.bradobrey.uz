// Pure Postgres connection resolution, shared by the pool (postgres.js) and
// startup env validation (env.js). Has no side effects: it only reads `env`.

const SSL_ENABLED_VALUES = new Set(['1', 'true', 'yes', 'require']);

const hasDiscretePostgresConfig = (env = process.env) => Boolean(
  (env.PGDATABASE || env.POSTGRES_DB) &&
  (env.PGHOST || env.POSTGRES_HOST) &&
  (env.PGUSER || env.POSTGRES_USER)
);

const isValidConnectionString = (value) => {
  if (!value) return false;

  try {
    const parsed = new URL(value);
    return ['postgres:', 'postgresql:'].includes(parsed.protocol);
  } catch (_err) {
    return false;
  }
};

const createPoolConfig = (env = process.env) => {
  const connectionString =
    env.DATABASE_URL ||
    env.POSTGRES_URL ||
    env.POSTGRES_CONNECTION_STRING;

  const sslValue = String(env.POSTGRES_SSL || env.PGSSLMODE || '').toLowerCase();
  const ssl = SSL_ENABLED_VALUES.has(sslValue)
    ? { rejectUnauthorized: String(env.POSTGRES_SSL_REJECT_UNAUTHORIZED || 'true') !== 'false' }
    : undefined;
  // Fail a hung connect instead of waiting forever (pg default is no timeout).
  const connectionTimeoutMillis = Number(env.POSTGRES_CONNECTION_TIMEOUT_MS || 10000);

  if (connectionString && isValidConnectionString(connectionString)) {
    return {
      connectionString,
      connectionTimeoutMillis,
      max: Number(env.POSTGRES_POOL_MAX || 10),
      idleTimeoutMillis: Number(env.POSTGRES_IDLE_TIMEOUT_MS || 30000),
      ...(ssl ? { ssl } : {}),
    };
  }

  if (connectionString && !hasDiscretePostgresConfig(env)) {
    throw new Error(
      'Postgres DATABASE_URL is invalid: use a valid postgres:// URL or set PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD'
    );
  }

  if (!env.PGDATABASE && !env.POSTGRES_DB) {
    throw new Error(
      'Postgres env vars missing: set DATABASE_URL or PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD'
    );
  }

  return {
    connectionTimeoutMillis,
    database: env.PGDATABASE || env.POSTGRES_DB,
    host: env.PGHOST || env.POSTGRES_HOST || 'localhost',
    idleTimeoutMillis: Number(env.POSTGRES_IDLE_TIMEOUT_MS || 30000),
    max: Number(env.POSTGRES_POOL_MAX || 10),
    password: env.PGPASSWORD || env.POSTGRES_PASSWORD,
    port: Number(env.PGPORT || env.POSTGRES_PORT || 5432),
    user: env.PGUSER || env.POSTGRES_USER,
    ...(ssl ? { ssl } : {}),
  };
};

module.exports = {
  createPoolConfig,
  hasDiscretePostgresConfig,
  isValidConnectionString,
};
