const test = require('node:test');
const assert = require('node:assert/strict');

const { validateEnv } = require('../src/config/env');

const STRONG_SECRET = 'x'.repeat(48);
const DB_URL = 'postgres://user:password@127.0.0.1:5432/bradobrey';

const makeLogger = () => {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(String(message)) };
};

test('validateEnv throws and names JWT_SECRET when it is missing', () => {
  assert.throws(
    () => validateEnv({ DATABASE_URL: DB_URL }, { logger: makeLogger() }),
    (error) => error.message.includes('JWT_SECRET')
  );
});

test('validateEnv treats a blank JWT_SECRET as missing', () => {
  assert.throws(
    () => validateEnv({ DATABASE_URL: DB_URL, JWT_SECRET: '   ' }, { logger: makeLogger() }),
    /JWT_SECRET/
  );
});

test('validateEnv throws when no database connection is configured', () => {
  assert.throws(
    () => validateEnv({ JWT_SECRET: STRONG_SECRET }, { logger: makeLogger() }),
    /DATABASE_URL/
  );
});

test('validateEnv lists every missing requirement in one error', () => {
  assert.throws(
    () => validateEnv({}, { logger: makeLogger() }),
    (error) => error.message.includes('JWT_SECRET') && error.message.includes('DATABASE_URL')
  );
});

test('validateEnv passes when JWT_SECRET and DATABASE_URL are set', () => {
  const logger = makeLogger();
  assert.doesNotThrow(() => validateEnv({ DATABASE_URL: DB_URL, JWT_SECRET: STRONG_SECRET }, { logger }));
  assert.deepEqual(logger.warnings, []);
});

test('validateEnv accepts discrete PG vars like the pool does', () => {
  assert.doesNotThrow(() => validateEnv({
    JWT_SECRET: STRONG_SECRET,
    PGDATABASE: 'bradobrey',
    PGHOST: '127.0.0.1',
    PGUSER: 'bradobrey',
  }, { logger: makeLogger() }));
});

test('validateEnv only warns in production for weak or missing optional secrets', () => {
  const logger = makeLogger();
  const weakSecret = 'short-secret';

  assert.doesNotThrow(() => validateEnv({
    DATABASE_URL: DB_URL,
    JWT_SECRET: weakSecret,
    NODE_ENV: 'production',
  }, { logger }));

  const output = logger.warnings.join('\n');
  assert.match(output, /KIOSK_SOCKET_SECRET/);
  assert.match(output, /OTP_HASH_SECRET/);
  assert.match(output, /TRUST_PROXY/);
  assert.match(output, /JWT_SECRET/);
  assert.ok(!output.includes(weakSecret), 'secret values must never be logged');
});

test('validateEnv does not warn outside production', () => {
  const logger = makeLogger();
  validateEnv({ DATABASE_URL: DB_URL, JWT_SECRET: 'short', NODE_ENV: 'development' }, { logger });
  assert.deepEqual(logger.warnings, []);
});
