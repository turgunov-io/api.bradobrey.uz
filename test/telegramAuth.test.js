const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config();

const { TelegramAuthService, TelegramAuthError } = require('../src/services/telegramAuth');

const TEST_ENV = {
  TELEGRAM_API_ID: '123456',
  TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef',
  TELEGRAM_SESSION_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  JWT_SECRET: 'telegram-test-jwt-secret',
  JWT_EXPIRES_IN: '1h',
};

class FakePool {
  constructor() {
    this.challenge = null;
    this.account = null;
    this.telegramSession = null;
  }

  async connect() {
    return new FakeConnection(this);
  }

  async query(sql, params = []) {
    return this.execute(sql, params);
  }

  async execute(sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(normalized)) return { rows: [] };
    if (normalized.startsWith('update telegram_auth_challenges set used_at = coalesce')) {
      if (this.challenge?.phone === params[0]) this.challenge.usedAt = new Date();
      return { rows: [] };
    }
    if (normalized.startsWith('insert into telegram_auth_challenges')) {
      this.challenge = {
        challengeHash: params[0],
        phone: params[1],
        phoneCodeHashEncrypted: params[2],
        telegramSessionEncrypted: params[3],
        attempts: 0,
        maxAttempts: params[4],
        twoFactorRequired: false,
        expiresAt: Date.now() + Number(params[5]),
        usedAt: null,
        lockedUntil: null,
      };
      return { rows: [] };
    }
    if (normalized.startsWith('select challenge_hash, phone')) {
      const challenge = this.challenge;
      const usable = challenge
        && challenge.challengeHash === params[0]
        && !challenge.usedAt
        && challenge.expiresAt > Date.now()
        && (!challenge.lockedUntil || challenge.lockedUntil < Date.now());
      return { rows: usable ? [{
        challenge_hash: challenge.challengeHash,
        phone: challenge.phone,
        phone_code_hash_encrypted: challenge.phoneCodeHashEncrypted,
        telegram_session_encrypted: challenge.telegramSessionEncrypted,
        attempts: challenge.attempts,
        max_attempts: challenge.maxAttempts,
        two_factor_required: challenge.twoFactorRequired,
        display_name: challenge.displayName || null,
        language: challenge.language || null,
      }] : [] };
    }
    if (normalized.startsWith('update telegram_auth_challenges set attempts')) {
      this.challenge.attempts += 1;
      this.challenge.lockedUntil = Date.now() + Number(params[1]);
      this.challenge.displayName = params[2] || this.challenge.displayName;
      this.challenge.language = params[3] || this.challenge.language;
      return { rows: [] };
    }
    if (normalized.startsWith('update telegram_auth_challenges set telegram_session_encrypted')) {
      this.challenge.telegramSessionEncrypted = params[0];
      this.challenge.twoFactorRequired = params[1] === true;
      this.challenge.lockedUntil = null;
      return { rows: [] };
    }
    if (normalized.startsWith('update telegram_auth_challenges set locked_until')) {
      this.challenge.lockedUntil = null;
      if (params[1]) this.challenge.telegramSessionEncrypted = params[1];
      if (params[2] === true) this.challenge.twoFactorRequired = true;
      return { rows: [] };
    }
    if (normalized.startsWith('select id, email, phone, display_name')) {
      return { rows: this.account ? [this.account] : [] };
    }
    if (normalized.startsWith('update marketplace_clients')) {
      this.account.display_name ||= params[1];
      this.account.language = params[2] || this.account.language;
      this.account.last_login_at = new Date();
      return { rows: [this.account] };
    }
    if (normalized.startsWith('insert into marketplace_clients')) {
      this.account = {
        id: crypto.randomUUID(),
        email: null,
        phone: params[0],
        display_name: params[1],
        language: params[2] || 'ru',
        is_active: true,
      };
      return { rows: [this.account] };
    }
    if (normalized.startsWith('insert into telegram_auth_sessions')) {
      this.telegramSession = { phone: params[0], encrypted: params[3] };
      return { rows: [] };
    }
    if (normalized.startsWith('update telegram_auth_challenges set used_at = now()')) {
      this.challenge.usedAt = new Date();
      this.challenge.lockedUntil = null;
      this.challenge.telegramSessionEncrypted = params[1];
      return { rows: [] };
    }
    throw new Error(`Unexpected fake SQL: ${normalized}`);
  }
}

class FakeConnection {
  constructor(pool) {
    this.pool = pool;
  }

  query(sql, params) {
    return this.pool.execute(sql, params || []);
  }

  release() {}
}

const makeClientFactory = ({ requiresPassword = true } = {}) => {
  const calls = { connect: 0, disconnect: 0, sendCode: 0, invoke: 0, password: 0 };
  const factory = () => ({
    session: { save: () => 'plaintext-session-value' },
    async connect() { calls.connect += 1; },
    async disconnect() { calls.disconnect += 1; },
    async sendCode() {
      calls.sendCode += 1;
      return { phoneCodeHash: 'plaintext-phone-code-hash', isCodeViaApp: true };
    },
    async invoke() {
      calls.invoke += 1;
      if (requiresPassword) {
        const error = new Error('two factor required');
        error.errorMessage = 'SESSION_PASSWORD_NEEDED';
        throw error;
      }
      return { user: { id: 'telegram-user-1', firstName: 'Test', lastName: 'User' } };
    },
    async signInWithPassword() {
      calls.password += 1;
      return { id: 'telegram-user-1', firstName: 'Test', lastName: 'User' };
    },
  });
  return { factory, calls };
};

test('Telegram request-code validates configuration and stores encrypted challenge state', async () => {
  const pool = new FakePool();
  const { factory, calls } = makeClientFactory();
  const service = new TelegramAuthService({ pool, clientFactory: factory, env: TEST_ENV });

  const result = await service.requestCode({ phone: '+998 90 123 45 67' });

  assert.match(result.challenge_id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.code_via_app, true);
  assert.equal(calls.sendCode, 1);
  assert.equal(calls.disconnect, 1);
  assert.ok(pool.challenge);
  assert.doesNotMatch(pool.challenge.phoneCodeHashEncrypted, /plaintext-phone-code-hash/);
  assert.doesNotMatch(pool.challenge.telegramSessionEncrypted, /plaintext-session-value/);
});

test('Telegram verify returns stable 2FA response, then completes with password', async () => {
  const pool = new FakePool();
  const { factory, calls } = makeClientFactory();
  const service = new TelegramAuthService({ pool, clientFactory: factory, env: TEST_ENV });
  const { challenge_id: challengeId } = await service.requestCode({ phone: '+998901234567' });

  await assert.rejects(
    service.verifyCode({ challengeId, code: '12345', displayName: 'Existing name' }),
    (error) => error instanceof TelegramAuthError
      && error.status === 409
      && error.code === 'TELEGRAM_2FA_REQUIRED',
  );
  assert.equal(pool.challenge.twoFactorRequired, true);

  const result = await service.verifyCode({ challengeId, code: '12345', password: '2fa-password' });

  assert.equal(calls.password, 1);
  assert.equal(result.client.phone, '+998901234567');
  assert.equal(result.client.display_name, 'Existing name');
  assert.equal(result.client.is_active, true);
  assert.ok(result.token);
  assert.equal(pool.challenge.usedAt instanceof Date, true);
  assert.ok(pool.telegramSession.encrypted);
});

test('Telegram auth fails safely when API credentials are missing', async () => {
  const service = new TelegramAuthService({
    pool: new FakePool(),
    clientFactory: () => { throw new Error('network must not be reached'); },
    env: { ...TEST_ENV, TELEGRAM_API_HASH: '' },
  });

  await assert.rejects(
    service.requestCode({ phone: '+998901234567' }),
    (error) => error.code === 'TELEGRAM_NOT_CONFIGURED' && error.status === 503,
  );
});
