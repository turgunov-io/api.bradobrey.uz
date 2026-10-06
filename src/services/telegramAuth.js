const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');

const { pool: defaultPool } = require('../config/postgres');

const MARKETPLACE_ROLE = 'marketplace';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_MAX_ATTEMPTS = 5;
const VERIFY_LOCK_MS = 2 * 60 * 1000;

class TelegramAuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'TelegramAuthError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

const normalizePhone = (phoneInput) => {
  const phone = String(phoneInput || '').trim().replace(/[\s()-]/g, '');
  return phone || null;
};

const isValidE164 = (phone) => /^\+\d{7,15}$/.test(phone || '');

const normalizeCode = (codeInput) => String(codeInput || '').trim().replace(/[\s-]/g, '');

const isValidCode = (code) => /^\d{3,8}$/.test(code || '');

const hashChallenge = (challengeId) => crypto
  .createHash('sha256')
  .update(challengeId, 'utf8')
  .digest('hex');

const parseEncryptionKey = (rawValue) => {
  const raw = String(rawValue || '').trim();
  if (/^[a-f\d]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');

  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) {
      return decoded;
    }
  } catch (_) {
    // The caller turns an invalid/missing key into a safe configuration error.
  }

  return null;
};

const encryptSecret = (value, key) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
};

const decryptSecret = (payload, key) => {
  const parts = String(payload || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid encrypted payload');

  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

const defaultClientFactory = ({ session, apiId, apiHash }) => new TelegramClient(
  new StringSession(session || ''),
  apiId,
  apiHash,
  { connectionRetries: 3 },
);

const telegramErrorName = (error) => String(
  error?.errorMessage || error?.message || error?.code || '',
).toUpperCase();

const isSessionPasswordNeeded = (error) => telegramErrorName(error).includes('SESSION_PASSWORD_NEEDED');

const isSignUpRequired = (result) => result instanceof Api.auth.AuthorizationSignUpRequired
  || String(result?.className || '').includes('AuthorizationSignUpRequired');

const getTelegramUser = (result) => result?.user || result;

const telegramUserId = (user) => {
  if (user?.id === undefined || user?.id === null) return null;
  return String(user.id);
};

const telegramDisplayName = (user) => [user?.firstName, user?.lastName]
  .map((value) => String(value || '').trim())
  .filter(Boolean)
  .join(' ')
  .slice(0, 120);

const safeErrorCode = (error) => telegramErrorName(error).replace(/[^A-Z0-9_]/g, '').slice(0, 80);

class TelegramAuthService {
  constructor({ pool = defaultPool, clientFactory = defaultClientFactory, env = process.env } = {}) {
    this.pool = pool;
    this.clientFactory = clientFactory;
    this.env = env;
  }

  getConfig() {
    const apiId = Number(this.env.TELEGRAM_API_ID);
    const apiHash = String(this.env.TELEGRAM_API_HASH || '').trim();
    const encryptionKey = parseEncryptionKey(this.env.TELEGRAM_SESSION_ENCRYPTION_KEY);

    if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[a-f\d]{20,64}$/i.test(apiHash)) {
      throw new TelegramAuthError(503, 'TELEGRAM_NOT_CONFIGURED', 'Telegram authorization is not configured');
    }
    if (!encryptionKey) {
      throw new TelegramAuthError(503, 'TELEGRAM_SESSION_ENCRYPTION_NOT_CONFIGURED', 'Telegram session encryption is not configured');
    }

    return { apiId, apiHash, encryptionKey };
  }

  getJwtSecret() {
    const jwtSecret = String(this.env.JWT_SECRET || '').trim();
    if (!jwtSecret) throw new TelegramAuthError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured');
    return jwtSecret;
  }

  createClient(config, session = '') {
    return this.clientFactory({ session, apiId: config.apiId, apiHash: config.apiHash });
  }

  async disconnect(client) {
    if (!client || typeof client.disconnect !== 'function') return;
    try {
      await client.disconnect();
    } catch (_) {
      // The auth response must not be replaced by a disconnect transport error.
    }
  }

  async saveSession(client, config) {
    if (!client?.session || typeof client.session.save !== 'function') {
      throw new Error('Telegram client session is unavailable');
    }
    return encryptSecret(client.session.save(), config.encryptionKey);
  }

  async requestCode({ phone: phoneInput }) {
    const config = this.getConfig();
    const phone = normalizePhone(phoneInput);
    if (!isValidE164(phone)) {
      throw new TelegramAuthError(400, 'INVALID_PHONE', 'phone must be in E.164 format');
    }

    const client = this.createClient(config);
    try {
      await client.connect();
      const sentCode = await client.sendCode(
        { apiId: config.apiId, apiHash: config.apiHash },
        phone,
      );
      if (!sentCode?.phoneCodeHash) {
        throw new TelegramAuthError(502, 'TELEGRAM_CODE_NOT_SENT', 'Telegram did not return a challenge');
      }

      const challengeId = crypto.randomBytes(32).toString('base64url');
      const challengeHash = hashChallenge(challengeId);
      const phoneCodeHash = encryptSecret(sentCode.phoneCodeHash, config.encryptionKey);
      const telegramSession = await this.saveSession(client, config);
      const dbClient = await this.pool.connect();

      try {
        await dbClient.query('BEGIN');
        await dbClient.query(
          `update telegram_auth_challenges
              set used_at = coalesce(used_at, now()), locked_until = null
            where phone = $1 and used_at is null`,
          [phone],
        );
        await dbClient.query(
          `insert into telegram_auth_challenges
            (challenge_hash, phone, phone_code_hash_encrypted, telegram_session_encrypted,
             attempts, max_attempts, expires_at, two_factor_required)
           values ($1, $2, $3, $4, 0, $5, now() + ($6::text || ' milliseconds')::interval, false)`,
          [challengeHash, phone, phoneCodeHash, telegramSession, CHALLENGE_MAX_ATTEMPTS, CHALLENGE_TTL_MS],
        );
        await dbClient.query('COMMIT');
      } catch (error) {
        try { await dbClient.query('ROLLBACK'); } catch (_) { /* ignore */ }
        if (error?.code === '42P01') {
          throw new TelegramAuthError(503, 'TELEGRAM_AUTH_STORAGE_NOT_READY', 'Telegram authorization storage is not ready');
        }
        throw error;
      } finally {
        dbClient.release();
      }

      return { challenge_id: challengeId, code_via_app: Boolean(sentCode.isCodeViaApp) };
    } catch (error) {
      if (error instanceof TelegramAuthError) throw error;
      throw this.mapTelegramError(error, 'TELEGRAM_CODE_REQUEST_FAILED');
    } finally {
      await this.disconnect(client);
    }
  }

  async reserveChallenge(challengeHash, passwordProvided, displayName, language) {
    const dbClient = await this.pool.connect();
    try {
      await dbClient.query('BEGIN');
      const result = await dbClient.query(
        `select challenge_hash, phone, phone_code_hash_encrypted, telegram_session_encrypted,
                attempts, max_attempts, two_factor_required, display_name, language
           from telegram_auth_challenges
          where challenge_hash = $1
            and used_at is null
            and expires_at > now()
            and (locked_until is null or locked_until < now())
          for update`,
        [challengeHash],
      );
      const challenge = result.rows[0];
      if (!challenge) {
        await dbClient.query('ROLLBACK');
        throw new TelegramAuthError(400, 'INVALID_OR_EXPIRED_CHALLENGE', 'Invalid or expired challenge');
      }
      if (challenge.attempts >= challenge.max_attempts) {
        await dbClient.query(
          'update telegram_auth_challenges set used_at = now(), locked_until = null where challenge_hash = $1',
          [challengeHash],
        );
        await dbClient.query('COMMIT');
        throw new TelegramAuthError(429, 'TELEGRAM_CHALLENGE_ATTEMPTS_EXCEEDED', 'Too many verification attempts');
      }
      if (challenge.two_factor_required && !passwordProvided) {
        await dbClient.query('ROLLBACK');
        throw new TelegramAuthError(409, 'TELEGRAM_2FA_REQUIRED', 'Telegram 2FA password is required');
      }

      await dbClient.query(
        `update telegram_auth_challenges
            set attempts = attempts + 1,
                locked_until = now() + ($2::text || ' milliseconds')::interval,
                display_name = coalesce($3, display_name),
                language = coalesce($4, language)
          where challenge_hash = $1`,
        [challengeHash, VERIFY_LOCK_MS, displayName || null, language || null],
      );
      await dbClient.query('COMMIT');
      return challenge;
    } catch (error) {
      try { await dbClient.query('ROLLBACK'); } catch (_) { /* ignore */ }
      if (error instanceof TelegramAuthError) throw error;
      if (error?.code === '42P01') {
        throw new TelegramAuthError(503, 'TELEGRAM_AUTH_STORAGE_NOT_READY', 'Telegram authorization storage is not ready');
      }
      throw error;
    } finally {
      dbClient.release();
    }
  }

  async updateChallenge(challengeHash, fields) {
    const values = [];
    const assignments = [];
    for (const [column, value] of Object.entries(fields)) {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    values.push(challengeHash);
    await this.pool.query(
      `update telegram_auth_challenges set ${assignments.join(', ')} where challenge_hash = $${values.length}`,
      values,
    );
  }

  mapTelegramError(error, fallbackCode = 'TELEGRAM_AUTH_FAILED') {
    if (error instanceof TelegramAuthError) return error;
    const name = telegramErrorName(error);
    if (name.includes('PHONE_CODE_INVALID') || name.includes('PHONE_CODE_EMPTY')) {
      return new TelegramAuthError(400, 'TELEGRAM_CODE_INVALID', 'Invalid Telegram code');
    }
    if (name.includes('PHONE_CODE_EXPIRED') || name.includes('PHONE_CODE_HASH_EMPTY')) {
      return new TelegramAuthError(410, 'TELEGRAM_CODE_EXPIRED', 'Telegram code expired');
    }
    if (name.includes('PHONE_NUMBER_INVALID') || name.includes('PHONE_NUMBER_BANNED')) {
      return new TelegramAuthError(400, 'TELEGRAM_PHONE_INVALID', 'Telegram rejected this phone number');
    }
    if (name.includes('PHONE_NUMBER_FLOOD') || name.includes('FLOOD_WAIT')) {
      return new TelegramAuthError(429, 'TELEGRAM_RATE_LIMITED', 'Telegram temporarily limited this request');
    }
    if (name.includes('PASSWORD_HASH_INVALID') || name.includes('PASSWORD_INVALID')) {
      return new TelegramAuthError(400, 'TELEGRAM_PASSWORD_INVALID', 'Invalid Telegram 2FA password');
    }
    if (name.includes('SESSION_PASSWORD_NEEDED')) {
      return new TelegramAuthError(409, 'TELEGRAM_2FA_REQUIRED', 'Telegram 2FA password is required');
    }
    if (name.includes('AUTH_KEY_UNREGISTERED') || name.includes('AUTH_KEY_INVALID')) {
      return new TelegramAuthError(502, 'TELEGRAM_SESSION_INVALID', 'Telegram session is invalid');
    }
    return new TelegramAuthError(502, fallbackCode, 'Telegram authorization failed');
  }

  async signInWithPassword(client, config, password) {
    try {
      return await client.signInWithPassword(
        { apiId: config.apiId, apiHash: config.apiHash },
        {
          password: async () => password,
          onError: async (error) => { throw error; },
        },
      );
    } catch (error) {
      throw this.mapTelegramError(error, 'TELEGRAM_PASSWORD_FAILED');
    }
  }

  async verifyCode({
    challengeId,
    code: codeInput,
    password: passwordInput,
    displayName: displayNameInput,
    language: languageInput,
  }) {
    const config = this.getConfig();
    const jwtSecret = this.getJwtSecret();
    const challenge = String(challengeId || '').trim();
    const code = normalizeCode(codeInput);
    const password = passwordInput === undefined || passwordInput === null
      ? null
      : String(passwordInput);
    const displayName = String(displayNameInput || '').trim().slice(0, 120);
    const language = languageInput === undefined || languageInput === null || languageInput === ''
      ? null
      : String(languageInput).trim().toLowerCase();

    if (!/^[A-Za-z0-9_-]{32,64}$/.test(challenge)) {
      throw new TelegramAuthError(400, 'INVALID_CHALLENGE_ID', 'challenge_id is invalid');
    }
    if (!isValidCode(code)) {
      throw new TelegramAuthError(400, 'INVALID_TELEGRAM_CODE', 'A valid Telegram code is required');
    }
    if (password !== null && (password.length < 1 || password.length > 256)) {
      throw new TelegramAuthError(400, 'INVALID_TELEGRAM_PASSWORD', 'Invalid Telegram 2FA password');
    }
    if (language !== null && !['uz', 'ru', 'en'].includes(language)) {
      throw new TelegramAuthError(400, 'INVALID_LANGUAGE', 'language must be uz, ru, or en');
    }

    const challengeHash = hashChallenge(challenge);
    const reserved = await this.reserveChallenge(
      challengeHash,
      password !== null,
      displayName,
      language,
    );
    const savedDisplayName = displayName || reserved.display_name || '';
    const savedLanguage = language || reserved.language || null;
    const session = decryptSecret(reserved.telegram_session_encrypted, config.encryptionKey);
    const phoneCodeHash = decryptSecret(reserved.phone_code_hash_encrypted, config.encryptionKey);
    const client = this.createClient(config, session);
    let authUser;
    let passwordRequired = Boolean(reserved.two_factor_required);

    try {
      await client.connect();
      if (passwordRequired) {
        authUser = await this.signInWithPassword(client, config, password);
      } else {
        try {
          const signInResult = await client.invoke(new Api.auth.SignIn({
            phoneNumber: reserved.phone,
            phoneCodeHash,
            phoneCode: code,
          }));
          if (isSignUpRequired(signInResult)) {
            throw new TelegramAuthError(409, 'TELEGRAM_SIGNUP_REQUIRED', 'This Telegram account requires sign-up');
          }
          authUser = getTelegramUser(signInResult);
        } catch (error) {
          if (!isSessionPasswordNeeded(error)) throw this.mapTelegramError(error);
          passwordRequired = true;
          if (password === null) {
            await this.updateChallenge(challengeHash, {
              telegram_session_encrypted: await this.saveSession(client, config),
              two_factor_required: true,
              locked_until: null,
            });
            throw new TelegramAuthError(409, 'TELEGRAM_2FA_REQUIRED', 'Telegram 2FA password is required');
          }
          authUser = await this.signInWithPassword(client, config, password);
        }
      }

      const encryptedSession = await this.saveSession(client, config);
      const user = getTelegramUser(authUser);
      const account = await this.completeLogin({
        challengeHash,
        phone: reserved.phone,
        displayName: savedDisplayName,
        language: savedLanguage,
        encryptedSession,
        telegramUserId: telegramUserId(user),
        telegramDisplayName: telegramDisplayName(user),
      });

      return {
        token: jwt.sign(
          { sub: account.id, email: account.email || null, phone: account.phone, role: MARKETPLACE_ROLE },
          jwtSecret,
          { expiresIn: this.env.JWT_EXPIRES_IN || '12h' },
        ),
        client: {
          id: account.id,
          phone: account.phone,
          display_name: account.display_name,
          language: account.language,
          is_active: account.is_active,
        },
      };
    } catch (error) {
      if (error instanceof TelegramAuthError && error.code === 'TELEGRAM_2FA_REQUIRED') throw error;
      const mapped = error instanceof TelegramAuthError ? error : this.mapTelegramError(error);
      const latestSession = await this.saveSession(client, config).catch(() => null);
      const failedFields = {
        locked_until: null,
        ...(latestSession ? { telegram_session_encrypted: latestSession } : {}),
        ...(passwordRequired ? { two_factor_required: true } : {}),
      };
      await this.updateChallenge(challengeHash, failedFields).catch(() => {});
      throw mapped;
    } finally {
      await this.disconnect(client);
    }
  }

  async completeLogin({
    challengeHash,
    phone,
    displayName,
    language,
    encryptedSession,
    telegramUserId,
    telegramDisplayName: telegramName,
  }) {
    const dbClient = await this.pool.connect();
    try {
      await dbClient.query('BEGIN');
      const existingResult = await dbClient.query(
        `select id, email, phone, display_name, language, is_active
           from marketplace_clients where phone = $1 for update`,
        [phone],
      );
      const existing = existingResult.rows[0];
      if (existing?.is_active === false) {
        await dbClient.query('ROLLBACK');
        throw new TelegramAuthError(403, 'ACCOUNT_DISABLED', 'Account is disabled');
      }

      const requestedName = displayName || telegramName || 'Client';
      const accountResult = existing
        ? await dbClient.query(
          `update marketplace_clients
              set display_name = case when (display_name is null or display_name = '') then $2 else display_name end,
                  language = coalesce($3, language),
                  last_login_at = now()
            where id = $1
            returning id, email, phone, display_name, language, is_active`,
          [existing.id, requestedName, language],
        )
        : await dbClient.query(
          `insert into marketplace_clients (phone, display_name, language, is_active, last_login_at)
           values ($1, $2, coalesce($3, 'ru'), true, now())
           returning id, email, phone, display_name, language, is_active`,
          [phone, requestedName, language],
        );
      const account = accountResult.rows[0];
      if (!account || account.is_active === false) {
        await dbClient.query('ROLLBACK');
        throw new TelegramAuthError(403, 'ACCOUNT_DISABLED', 'Account is disabled');
      }

      await dbClient.query(
        `insert into telegram_auth_sessions
          (phone, marketplace_client_id, telegram_user_id, session_encrypted, last_used_at)
         values ($1, $2, $3, $4, now())
         on conflict (phone) do update set
           marketplace_client_id = excluded.marketplace_client_id,
           telegram_user_id = excluded.telegram_user_id,
           session_encrypted = excluded.session_encrypted,
           last_used_at = now()`,
        [phone, account.id, telegramUserId, encryptedSession],
      );
      await dbClient.query(
        `update telegram_auth_challenges
            set used_at = now(), locked_until = null, telegram_session_encrypted = $2
          where challenge_hash = $1 and used_at is null`,
        [challengeHash, encryptedSession],
      );
      await dbClient.query('COMMIT');
      return account;
    } catch (error) {
      try { await dbClient.query('ROLLBACK'); } catch (_) { /* ignore */ }
      if (error?.code === '42P01') {
        throw new TelegramAuthError(503, 'TELEGRAM_AUTH_STORAGE_NOT_READY', 'Telegram authorization storage is not ready');
      }
      throw error;
    } finally {
      dbClient.release();
    }
  }
}

const service = new TelegramAuthService();

module.exports = service;
module.exports.TelegramAuthService = TelegramAuthService;
module.exports.TelegramAuthError = TelegramAuthError;
module.exports._internals = {
  decryptSecret,
  encryptSecret,
  hashChallenge,
  isValidE164,
  normalizePhone,
  parseEncryptionKey,
};
