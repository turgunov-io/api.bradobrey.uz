const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const { pool: defaultPool } = require('../config/postgres');
const TelegramBotService = require('./telegram-bot.service');
const { TelegramBotError } = require('./telegram-bot.service');

const MARKETPLACE_ROLE = 'marketplace';
const LINK_TTL_SECONDS = 5 * 60;
const OTP_TTL_SECONDS = 60;
const RATE_LIMIT_WINDOW_SECONDS = 24 * 60 * 60;
const OTP_COOLDOWNS_SECONDS = [0, 60, 2 * 60, 5 * 60, 15 * 60];
const MAX_ATTEMPTS = 5;
const VERIFY_LOCK_MS = 2 * 1000;

class TelegramAuthError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'TelegramAuthError';
    this.status = status;
    this.code = code;
    this.expose = true;
    Object.assign(this, details);
  }
}

const normalizePhone = (phoneInput) => {
  let phone = String(phoneInput || '').trim().replace(/[\s()-]/g, '');
  if (/^00\d{7,15}$/.test(phone)) phone = `+${phone.slice(2)}`;
  else if (/^\d{7,15}$/.test(phone)) phone = `+${phone}`;
  return phone || null;
};
const isValidE164 = (phone) => /^\+\d{7,15}$/.test(phone || '');
const normalizeCode = (codeInput) => String(codeInput || '').trim().replace(/[\s-]/g, '');
const isValidCode = (code) => /^\d{6}$/.test(code || '');
const createOpaqueToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
const cleanName = (value) => String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
const maskedPhone = (phone) => `${String(phone || '').slice(0, 6)}****${String(phone || '').slice(-2)}`;

const sameSecret = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

class TelegramAuthService {
  constructor({ pool = defaultPool, botService, fetchImpl = globalThis.fetch, env = process.env } = {}) {
    this.pool = pool;
    this.env = env;
    this.bot = botService || new TelegramBotService({ fetchImpl, env });
  }

  getJwtSecret() {
    const secret = String(this.env.JWT_SECRET || '').trim();
    if (!secret) throw new TelegramAuthError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured');
    return secret;
  }

  getOtpHashSecret() {
    const secret = String(this.env.OTP_HASH_SECRET || this.env.JWT_SECRET || '').trim();
    if (!secret) throw new TelegramAuthError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured');
    return secret;
  }

  hashOtp(code) {
    return crypto.createHmac('sha256', this.getOtpHashSecret()).update(code, 'utf8').digest('hex');
  }

  mapBotError(error, fallback = 'TELEGRAM_BOT_UNAVAILABLE') {
    if (error instanceof TelegramAuthError) return error;
    if (error instanceof TelegramBotError && error.code === 'BOT_NOT_CONFIGURED') {
      return new TelegramAuthError(503, 'TELEGRAM_BOT_NOT_CONFIGURED', 'Telegram bot is not configured');
    }
    return new TelegramAuthError(502, fallback, 'Telegram delivery is temporarily unavailable');
  }

  dbError(error) {
    if (error?.code === '42P01' || error?.code === '42703') {
      return new TelegramAuthError(503, 'TELEGRAM_AUTH_STORAGE_NOT_READY', 'Telegram authorization storage is not ready');
    }
    if (error?.code === '23505') return new TelegramAuthError(409, 'TELEGRAM_BINDING_CONFLICT', 'This Telegram account is already linked');
    return error;
  }

  async reserveSend({ displayName, firstName, lastName, patronymic, referralCode, language, purpose = 'registration' }) {
    const client = await this.pool.connect();
    const linkToken = createOpaqueToken();
    const challengeId = createOpaqueToken();
    const challengeHash = hashToken(challengeId);
    try {
      await client.query('BEGIN');
      await client.query(
        `insert into telegram_auth_challenges
          (challenge_hash, phone, attempts, max_attempts, expires_at, status, link_token_hash, otp_hash,
           telegram_user_id, telegram_chat_id, display_name, first_name, last_name, patronymic, referral_code, purpose, language)
         values ($1, null, 0, $2, now() + ($3::text || ' seconds')::interval, 'awaiting_telegram_link', $4, null,
           null, null, nullif($5, ''), nullif($6, ''), nullif($7, ''), nullif($8, ''), nullif($9, ''), $10, nullif($11, ''))`,
        [challengeHash, MAX_ATTEMPTS, LINK_TTL_SECONDS, hashToken(linkToken), cleanName(displayName), cleanName(firstName), cleanName(lastName), cleanName(patronymic), String(referralCode || '').trim().toUpperCase(), ['login', 'registration'].includes(purpose) ? purpose : 'registration', language || null],
      );
      await client.query('COMMIT');
      return { challengeId, challengeHash, linkToken, requiresLink: true };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw this.dbError(error);
    } finally { client.release(); }
  }

  async updateChallenge(challengeHash, fields) {
    const allowed = new Set(['status', 'locked_until', 'used_at', 'delivery_status', 'verification_status', 'otp_hash', 'telegram_user_id', 'telegram_chat_id', 'link_token_hash']);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    if (!entries.length) return;
    const values = entries.map(([, value]) => value);
    values.push(challengeHash);
    const assignments = entries.map(([key], index) => `${key} = $${index + 1}`).join(', ');
    try { await this.pool.query(`update telegram_auth_challenges set ${assignments}, updated_at = now() where challenge_hash = $${values.length}`, values); }
    catch (error) { throw this.dbError(error); }
  }

  async sendOtp(challenge, code) {
    try {
      await this.bot.sendMessage(challenge.chatId, `Ваш код для входа в Bradobrey: ${code}\nКод действует 60 секунд.`, {
        reply_markup: { inline_keyboard: [[{ text: '📋 Копировать код', copy_text: { text: code } }]] },
      });
      await this.updateChallenge(challenge.challengeHash, { delivery_status: 'sent' });
    } catch (error) {
      await this.updateChallenge(challenge.challengeHash, { status: 'failed', used_at: new Date(), delivery_status: 'failed' }).catch(() => {});
      throw this.mapBotError(error, 'TELEGRAM_CODE_SEND_FAILED');
    }
  }

  async sendCode({ displayName, firstName, lastName, patronymic, referralCode, language, purpose }) {
    const reservation = await this.reserveSend({ displayName, firstName, lastName, patronymic, referralCode, language, purpose });
    let botUrl;
    try { botUrl = this.bot.botUrl(reservation.linkToken); } catch (error) { throw this.mapBotError(error); }
    return {
      requiresTelegramLink: true,
      requiresTelegram: true,
      linkToken: reservation.linkToken,
      botUrl,
      telegramUrl: botUrl,
      challenge_id: reservation.challengeId,
      sessionId: reservation.challengeId,
      expiresIn: LINK_TTL_SECONDS,
      expires_in: LINK_TTL_SECONDS,
      retry_after: OTP_COOLDOWNS_SECONDS[1],
    };
  }

  async linkTelegram({ linkToken, telegramUserId, telegramChatId }) {
    const client = await this.pool.connect();
    const tokenHash = hashToken(linkToken);
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `select challenge_hash, phone, status, telegram_user_id, telegram_chat_id from telegram_auth_challenges
          where link_token_hash = $1 and used_at is null and expires_at > now() for update`, [tokenHash],
      );
      const challenge = result.rows[0];
      if (!challenge) { await client.query('ROLLBACK'); throw new TelegramAuthError(410, 'LINK_TOKEN_EXPIRED', 'Telegram link has expired'); }
      if (challenge.status !== 'awaiting_telegram_link') {
        const sameChat = String(challenge.telegram_chat_id || '') === String(telegramChatId);
        await client.query('ROLLBACK');
        if (sameChat && ['awaiting_contact', 'awaiting_phone', 'pending'].includes(challenge.status)) return { alreadyProcessed: true };
        throw new TelegramAuthError(409, 'LINK_TOKEN_USED', 'Telegram link has already been used');
      }
      const account = await client.query(`select id, phone from marketplace_clients where telegram_user_id = $1 or telegram_chat_id = $2 for update`, [String(telegramUserId), String(telegramChatId)]);
      if (account.rows.find((row) => challenge.phone && row.phone && row.phone !== challenge.phone)) {
        await client.query('ROLLBACK');
        throw new TelegramAuthError(409, 'TELEGRAM_BINDING_CONFLICT', 'This Telegram account is already linked');
      }
      const pending = await client.query(
        `select phone from telegram_auth_challenges where used_at is null and status in ('awaiting_phone', 'pending')
          and (telegram_user_id = $1 or telegram_chat_id = $2) and phone <> $3 limit 1`, [String(telegramUserId), String(telegramChatId), challenge.phone],
      );
      if (pending.rows[0]) { await client.query('ROLLBACK'); throw new TelegramAuthError(409, 'TELEGRAM_BINDING_CONFLICT', 'This Telegram account is already linked'); }
      await client.query(
        `update telegram_auth_challenges set status = 'awaiting_contact', otp_hash = null, telegram_user_id = $2, telegram_chat_id = $3,
          expires_at = now() + ($4::text || ' seconds')::interval, delivery_status = 'awaiting_phone', updated_at = now()
          where challenge_hash = $1`, [challenge.challenge_hash, String(telegramUserId), String(telegramChatId), LINK_TTL_SECONDS],
      );
      await client.query('COMMIT');
      return { challengeHash: challenge.challenge_hash, chatId: String(telegramChatId) };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw this.dbError(error);
    } finally { client.release(); }
  }

  async confirmTelegramContact({ telegramUserId, telegramChatId, phone }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `select challenge_hash, phone, display_name, first_name, last_name, patronymic, language,
                telegram_user_id, telegram_chat_id, status, delivery_status
           from telegram_auth_challenges
          where telegram_user_id = $1 and telegram_chat_id = $2 and status = 'awaiting_contact'
            and used_at is null and expires_at > now()
          order by created_at desc limit 1 for update`,
        [String(telegramUserId), String(telegramChatId)],
      );
      const challenge = result.rows[0];
      if (!challenge) {
        await client.query('ROLLBACK');
        return null;
      }
      const rate = await client.query(
        `select count(*)::int as count, extract(epoch from (now() - max(created_at)))::int as age_seconds
           from telegram_auth_challenges where created_at > now() - interval '24 hours'
             and otp_hash is not null and (telegram_user_id = $1 or phone = $2)`, [String(telegramUserId), phone],
      );
      const count = Number(rate.rows[0]?.count || 0);
      const age = rate.rows[0]?.age_seconds === null || rate.rows[0]?.age_seconds === undefined ? null : Number(rate.rows[0].age_seconds);
      const cooldown = count >= OTP_COOLDOWNS_SECONDS.length ? RATE_LIMIT_WINDOW_SECONDS : OTP_COOLDOWNS_SECONDS[count];
      const retryAfter = age !== null && Number.isFinite(age) ? Math.max(0, cooldown - age) : 0;
      if (retryAfter > 0) {
        await client.query('ROLLBACK');
        throw new TelegramAuthError(429, 'OTP_RATE_LIMITED', 'Please wait before requesting another code', { retryAfter });
      }
      const existingByTelegram = await client.query(
        `select id, phone, is_active from marketplace_clients where telegram_user_id = $1 or telegram_chat_id = $2 for update`,
        [String(telegramUserId), String(telegramChatId)],
      );
      const conflicting = existingByTelegram.rows.find((row) => row.phone && row.phone !== phone);
      if (conflicting) {
        await client.query('ROLLBACK');
        throw new TelegramAuthError(409, 'TELEGRAM_PHONE_CHANGED', 'Telegram phone does not match the existing account');
      }
      const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
      await client.query(
        `update telegram_auth_challenges set status = 'pending', phone = $2, otp_hash = $3,
          expires_at = now() + ($4::text || ' seconds')::interval, delivery_status = 'pending', updated_at = now()
          where challenge_hash = $1`, [challenge.challenge_hash, phone, this.hashOtp(code), OTP_TTL_SECONDS],
      );
      await client.query('COMMIT');
      return { ...challenge, challengeHash: challenge.challenge_hash, phone, chatId: String(telegramChatId), code };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw this.dbError(error);
    } finally { client.release(); }
  }

  async handleWebhook(update) {
    const message = update?.message;
    const fromId = message?.from?.id;
    const chatId = message?.chat?.id;
    const text = String(message?.text || '').trim();
    if (fromId === undefined || chatId === undefined) return;
    if (/^\/help(?:@[^\s]+)?$/i.test(text)) {
      await this.bot.sendMessage(chatId, 'Bradobrey помогает подтвердить номер телефона. Откройте ссылку из приложения и нажмите Start, затем поделитесь своим контактом.');
      return;
    }
    if (message?.contact) {
      await this.handleContactMessage(update);
      return;
    }
    const match = text.match(/^\/start(?:@[^\s]+)?(?:\s+([A-Za-z0-9_-]{20,128}))?$/i);
    if (!match?.[1]) {
      await this.bot.sendMessage(chatId, 'Добро пожаловать в Bradobrey. Для подтверждения номера откройте ссылку из приложения.');
      return;
    }
    let linked;
    try {
      linked = await this.linkTelegram({ linkToken: match[1], telegramUserId: fromId, telegramChatId: chatId });
    } catch (error) {
      if (error instanceof TelegramAuthError && [409, 410].includes(error.status)) {
        await this.bot.sendMessage(chatId, 'Ссылка недействительна или уже использована. Вернитесь в приложение и запросите новую.');
        return;
      }
      throw error;
    }
    if (linked.alreadyProcessed) return;
    await this.bot.sendMessage(chatId, 'Для создания аккаунта Bradobrey необходимо подтвердить ваш Telegram-номер.\n\nНажмите кнопку ниже, чтобы поделиться номером телефона.', {
      reply_markup: {
        keyboard: [[{ text: '📱 Поделиться номером телефона', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }

  async handleContactMessage(update) {
    const message = update?.message;
    const fromId = message?.from?.id;
    const chatId = message?.chat?.id;
    if (fromId === undefined || chatId === undefined) return;
    const contactUserId = message?.contact?.user_id;
    if (contactUserId === undefined || String(contactUserId) !== String(fromId)) {
      await this.bot.sendMessage(chatId, 'Нельзя использовать чужой контакт. Нажмите кнопку и поделитесь своим номером телефона.');
      return;
    }
    const phone = normalizePhone(message.contact.phone_number);
    if (!isValidE164(phone)) {
      await this.bot.sendMessage(chatId, 'Не удалось распознать номер телефона. Попробуйте поделиться контактом ещё раз.');
      return;
    }
    let confirmed;
    try {
      confirmed = await this.confirmTelegramContact({ telegramUserId: fromId, telegramChatId: chatId, phone });
    } catch (error) {
      if (error instanceof TelegramAuthError && error.code === 'TELEGRAM_PHONE_CHANGED') {
        await this.bot.sendMessage(chatId, 'Этот Telegram-номер уже связан с другим аккаунтом. Обратитесь в поддержку для восстановления доступа.');
        return;
      }
      if (error instanceof TelegramAuthError && error.code === 'OTP_RATE_LIMITED') {
        await this.bot.sendMessage(chatId, `Новый код можно запросить через ${error.retryAfter} сек.`);
        return;
      }
      throw error;
    }
    if (!confirmed) {
      await this.bot.sendMessage(chatId, 'Откройте ссылку из приложения Bradobrey и нажмите Start.');
      return;
    }
    await this.sendOtp(confirmed, confirmed.code);
  }

  async reserveVerification(challengeHash, phone) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `select challenge_hash, phone, otp_hash, telegram_user_id, telegram_chat_id, attempts, max_attempts,
                display_name, first_name, last_name, patronymic, referral_code, purpose, language
           from telegram_auth_challenges where challenge_hash = $1 and ($2::text is null or phone = $2)
            and used_at is null and status = 'pending' and expires_at > now()
            and (locked_until is null or locked_until < now()) for update`, [challengeHash, phone || null],
      );
      const challenge = result.rows[0];
      if (!challenge) { await client.query('ROLLBACK'); throw new TelegramAuthError(410, 'VERIFICATION_SESSION_EXPIRED', 'Verification session expired'); }
      if (!challenge.otp_hash) { await client.query('ROLLBACK'); throw new TelegramAuthError(502, 'TELEGRAM_CODE_SEND_FAILED', 'Verification code was not sent'); }
      if (Number(challenge.attempts) >= Number(challenge.max_attempts)) {
        await client.query(`update telegram_auth_challenges set status = 'failed', used_at = now(), locked_until = null, updated_at = now() where challenge_hash = $1`, [challengeHash]);
        await client.query('COMMIT');
        throw new TelegramAuthError(429, 'TOO_MANY_CODE_ATTEMPTS', 'Too many verification attempts');
      }
      await client.query(`update telegram_auth_challenges set attempts = attempts + 1, locked_until = now() + ($2::text || ' milliseconds')::interval, updated_at = now() where challenge_hash = $1`, [challengeHash, VERIFY_LOCK_MS]);
      await client.query('COMMIT');
      return challenge;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw this.dbError(error);
    } finally { client.release(); }
  }

  async markInvalidCode(challengeHash, attempts, maxAttempts) {
    await this.updateChallenge(challengeHash, { locked_until: null, ...(Number(attempts) >= Number(maxAttempts) ? { status: 'failed', used_at: new Date() } : {}) });
  }

  async completeLogin({ challengeHash, phone, telegramUserId, telegramChatId, displayName, firstName, lastName, patronymic, referralCode, language }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existingResult = await client.query(`select id, email, phone, display_name, first_name, last_name, patronymic, language, is_active, telegram_user_id, telegram_chat_id from marketplace_clients where phone = $1 for update`, [phone]);
      const existing = existingResult.rows[0];
      if (existing?.is_active === false) { await client.query('ROLLBACK'); throw new TelegramAuthError(403, 'ACCOUNT_DISABLED', 'Account is disabled'); }
      if (existing && ((existing.telegram_user_id && String(existing.telegram_user_id) !== String(telegramUserId)) || (existing.telegram_chat_id && String(existing.telegram_chat_id) !== String(telegramChatId)))) {
        await client.query('ROLLBACK');
        throw new TelegramAuthError(409, 'TELEGRAM_BINDING_CONFLICT', 'This phone is already linked to another Telegram account');
      }
      const duplicate = await client.query(`select id from marketplace_clients where (telegram_user_id = $1 or telegram_chat_id = $2) and ($3::uuid is null or id <> $3) limit 1`, [String(telegramUserId), String(telegramChatId), existing?.id || null]);
      if (duplicate.rows[0]) { await client.query('ROLLBACK'); throw new TelegramAuthError(409, 'TELEGRAM_BINDING_CONFLICT', 'This Telegram account is already linked'); }
      const requestedName = cleanName(displayName) || [cleanName(firstName), cleanName(lastName)].filter(Boolean).join(' ') || existing?.display_name || 'Client';
      const safeLanguage = language && ['uz', 'ru', 'en'].includes(language) ? language : null;
      const accountResult = existing
        ? await client.query(`update marketplace_clients set display_name = case when display_name is null or display_name = '' then $2 else display_name end, first_name = case when first_name is null or first_name = '' then nullif($3, '') else first_name end, last_name = case when last_name is null or last_name = '' then nullif($4, '') else last_name end, patronymic = case when patronymic is null or patronymic = '' then nullif($5, '') else patronymic end, language = coalesce($6, language), telegram_user_id = $7, telegram_chat_id = $8, last_login_at = now() where id = $1 returning id, email, phone, display_name, first_name, last_name, patronymic, language, is_active`, [existing.id, requestedName, cleanName(firstName), cleanName(lastName), cleanName(patronymic), safeLanguage, String(telegramUserId), String(telegramChatId)])
        : await client.query(`insert into marketplace_clients (phone, display_name, first_name, last_name, patronymic, language, is_active, telegram_user_id, telegram_chat_id, last_login_at) values ($1, $2, nullif($3, ''), nullif($4, ''), nullif($5, ''), coalesce($6, 'ru'), true, $7, $8, now()) returning id, email, phone, display_name, first_name, last_name, patronymic, language, is_active`, [phone, requestedName, cleanName(firstName), cleanName(lastName), cleanName(patronymic), safeLanguage, String(telegramUserId), String(telegramChatId)]);
      const account = accountResult.rows[0];
      if (!existing && referralCode) {
        const referral = await client.query(
          `select marketplace_client_id, referral_code from referral_accounts
             where referral_code = $1 and marketplace_client_id <> $2 limit 1 for update`,
          [String(referralCode).trim().toUpperCase(), account.id],
        );
        if (!referral.rows[0]) {
          await client.query('ROLLBACK');
          throw new TelegramAuthError(400, 'INVALID_REFERRAL_CODE', 'Invalid referral code');
        }
        const settings = await client.query(`select value from platform_settings where key = 'referral'`);
        const expiryDays = Math.max(1, Number(settings.rows[0]?.value?.expiry_days || 365));
        await client.query(
          `insert into referrals (referrer_client_id, referred_client_id, referral_code, expires_at, source_ip, device_id)
             values ($1, $2, $3, now() + ($4::text || ' days')::interval, null, null)
             on conflict (referred_client_id) do nothing`,
          [referral.rows[0].marketplace_client_id, account.id, referral.rows[0].referral_code, expiryDays],
        );
      }
      const used = await client.query(`update telegram_auth_challenges set status = 'verified', used_at = now(), locked_until = null, updated_at = now() where challenge_hash = $1 and status = 'pending' and used_at is null returning challenge_hash`, [challengeHash]);
      if (!used.rows[0]) { await client.query('ROLLBACK'); throw new TelegramAuthError(410, 'VERIFICATION_SESSION_EXPIRED', 'Verification session expired'); }
      await client.query('COMMIT');
      return { account, isNew: !existing };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw this.dbError(error);
    } finally { client.release(); }
  }

  async verifyCode({ challengeId: challengeIdInput, phone: phoneInput, code: codeInput, displayName, firstName, lastName, patronymic, language }) {
    const challengeId = String(challengeIdInput || '').trim();
    const code = normalizeCode(codeInput);
    const normalizedLanguage = language === undefined || language === null || language === '' ? null : String(language).trim().toLowerCase();
    if (!isValidCode(code)) throw new TelegramAuthError(400, 'INVALID_CODE', 'A valid 6-digit verification code is required');
    if (normalizedLanguage !== null && !['uz', 'ru', 'en'].includes(normalizedLanguage)) throw new TelegramAuthError(400, 'INVALID_LANGUAGE', 'language must be uz, ru, or en');
    let challengeHash;
    if (challengeId) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(challengeId)) throw new TelegramAuthError(400, 'INVALID_CHALLENGE_ID', 'challenge_id is invalid');
      challengeHash = hashToken(challengeId);
    } else {
      const phone = normalizePhone(phoneInput);
      if (!isValidE164(phone)) throw new TelegramAuthError(400, 'INVALID_CHALLENGE_ID', 'challenge_id or phone is required');
      const latest = await this.pool.query(
        `select challenge_hash from telegram_auth_challenges where phone = $1 and status = 'pending' and used_at is null and expires_at > now() order by created_at desc limit 1`, [phone],
      );
      challengeHash = latest.rows[0]?.challenge_hash;
      if (!challengeHash) throw new TelegramAuthError(410, 'VERIFICATION_SESSION_EXPIRED', 'Verification session expired');
    }
    const reserved = await this.reserveVerification(challengeHash, null);
    if (!sameSecret(this.hashOtp(code), reserved.otp_hash)) {
      await this.markInvalidCode(reserved.challenge_hash, Number(reserved.attempts) + 1, reserved.max_attempts);
      throw new TelegramAuthError(400, 'INVALID_CODE', 'Invalid verification code');
    }
    const { account, isNew } = await this.completeLogin({
      challengeHash: reserved.challenge_hash,
      phone: reserved.phone,
      telegramUserId: reserved.telegram_user_id,
      telegramChatId: reserved.telegram_chat_id,
      displayName: reserved.display_name || displayName,
      firstName: reserved.first_name || firstName,
      lastName: reserved.last_name || lastName,
      patronymic: reserved.patronymic || patronymic,
      referralCode: reserved.referral_code,
      language: normalizedLanguage || reserved.language,
    });
    const token = jwt.sign({ sub: account.id, email: account.email || null, phone: account.phone, role: MARKETPLACE_ROLE }, this.getJwtSecret(), { expiresIn: this.env.JWT_EXPIRES_IN || '12h' });
    return {
      token,
      accessToken: token,
      verified: true, is_new_user: isNew,
      client: { id: account.id, phone: account.phone, display_name: account.display_name, first_name: account.first_name, last_name: account.last_name, patronymic: account.patronymic, language: account.language, is_active: account.is_active },
    };
  }

  requestCode(args) { return this.sendCode(args); }
}

const service = new TelegramAuthService();
module.exports = service;
module.exports.TelegramAuthService = TelegramAuthService;
module.exports.TelegramAuthError = TelegramAuthError;
module.exports._internals = { hashToken, isValidE164, normalizePhone, normalizeCode, isValidCode, maskedPhone };
