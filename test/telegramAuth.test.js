const test = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();

const { TelegramAuthService, TelegramAuthError, _internals } = require('../src/services/telegramAuth');

const ENV = { TELEGRAM_BOT_TOKEN: 'bot-secret', TELEGRAM_BOT_USERNAME: 'bradobrey_bot', JWT_SECRET: 'jwt-secret', OTP_HASH_SECRET: 'otp-secret', JWT_EXPIRES_IN: '1h' };

class FakeBot {
  constructor() { this.messages = []; }
  botUrl(token) { return `https://t.me/bradobrey_bot?start=${token}`; }
  async sendMessage(chatId, text) { this.messages.push({ chatId, text }); }
}

class FakePool {
  constructor(account = null) { this.account = account; this.challenge = null; }
  async connect() { return { query: (sql, params) => this.execute(sql, params || []), release() {} }; }
  async query(sql, params) { return this.execute(sql, params || []); }
  async execute(sql, params) {
    const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] };
    if (q.startsWith('select count(*)')) return { rows: [{ count: this.challenge ? 1 : 0, age_seconds: this.challenge ? 0 : null }] };
    if (q.startsWith('select id, telegram_user_id')) return { rows: this.account ? [this.account] : [] };
    if (q.startsWith('update telegram_auth_challenges set status = \'revoked\'')) { if (this.challenge) this.challenge.usedAt = true; return { rows: [] }; }
    if (q.startsWith('insert into telegram_auth_challenges')) {
      this.challenge = { challengeHash: params[0], phone: params[1], maxAttempts: params[2], attempts: 0, status: params[4], linkHash: params[5], otpHash: null, telegramUserId: params[6], telegramChatId: params[7], usedAt: false, createdAt: Date.now() };
      return { rows: [] };
    }
    if (q.startsWith('select challenge_hash, phone, status')) {
      return this.challenge && !this.challenge.usedAt && this.challenge.linkHash === params[0]
        ? { rows: [{ challenge_hash: this.challenge.challengeHash, phone: this.challenge.phone, status: this.challenge.status, telegram_user_id: this.challenge.telegramUserId, telegram_chat_id: this.challenge.telegramChatId }] } : { rows: [] };
    }
    if (q.startsWith('select id, phone from marketplace_clients')) return { rows: [] };
    if (q.startsWith('select phone from telegram_auth_challenges')) return { rows: [] };
    if (q.startsWith('select challenge_hash, phone, otp_hash')) {
      const usable = this.challenge && !this.challenge.usedAt && this.challenge.status === 'pending';
      return usable ? { rows: [{ challenge_hash: this.challenge.challengeHash, phone: this.challenge.phone, otp_hash: this.challenge.otpHash, telegram_user_id: this.challenge.telegramUserId, telegram_chat_id: this.challenge.telegramChatId, attempts: this.challenge.attempts, max_attempts: this.challenge.maxAttempts }] } : { rows: [] };
    }
    if (q.startsWith('update telegram_auth_challenges set attempts')) { this.challenge.attempts += 1; return { rows: [] }; }
    if (q.startsWith('update telegram_auth_challenges set status = \'verified\'')) { this.challenge.status = 'verified'; this.challenge.usedAt = true; return { rows: [{ challenge_hash: this.challenge.challengeHash }] }; }
    if (q.startsWith('update telegram_auth_challenges set')) {
      if (q.includes('otp_hash =')) this.challenge.otpHash = params[0];
      if (q.includes('status = \'pending\'')) { this.challenge.status = 'pending'; this.challenge.otpHash = params[1]; this.challenge.telegramUserId = params[2]; this.challenge.telegramChatId = params[3]; }
      if (q.includes('delivery_status')) this.challenge.deliveryStatus = params[0];
      if (q.includes("status = 'failed'")) { this.challenge.status = 'failed'; this.challenge.usedAt = true; }
      return { rows: [] };
    }
    if (q.startsWith('select id, email, phone')) return { rows: this.account ? [this.account] : [] };
    if (q.startsWith('select id from marketplace_clients')) return { rows: [] };
    if (q.startsWith('insert into marketplace_clients')) {
      this.account = { id: 'client-1', email: null, phone: params[0], display_name: params[1], language: params[4] || 'ru', is_active: true, telegram_user_id: params[5], telegram_chat_id: params[6] };
      return { rows: [this.account] };
    }
    if (q.startsWith('update marketplace_clients')) return { rows: [this.account] };
    throw new Error(`Unexpected fake SQL: ${q}`);
  }
}

const makeService = (pool, bot = new FakeBot()) => new TelegramAuthService({ pool, botService: bot, env: ENV });

test('unlinked phone receives a one-time Telegram deep link and no OTP', async () => {
  const pool = new FakePool();
  const result = await makeService(pool).sendCode({ phone: '+998 90 123 45 67' });
  assert.equal(result.requiresTelegramLink, true);
  assert.match(result.linkToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(result.botUrl, /^https:\/\/t\.me\/bradobrey_bot\?start=/);
  assert.equal(result.expiresIn, 300);
  assert.equal(pool.challenge.otpHash, null);
});

test('linked phone gets a cryptographically generated six-digit OTP stored only as HMAC', async () => {
  const pool = new FakePool({ id: 'client-1', telegram_user_id: '42', telegram_chat_id: '84', is_active: true });
  const bot = new FakeBot();
  const result = await makeService(pool, bot).sendCode({ phone: '+998901234567' });
  const code = bot.messages[0].text.match(/(\d{6})$/)[1];
  assert.match(code, /^\d{6}$/);
  assert.equal(result.expires_in, 300);
  assert.equal(pool.challenge.otpHash, new TelegramAuthService({ env: ENV }).hashOtp(code));
  assert.equal(pool.challenge.otpHash.includes(code), false);
});

test('webhook links Telegram, sends OTP, and duplicate delivery is idempotent', async () => {
  const pool = new FakePool();
  const bot = new FakeBot();
  const service = makeService(pool, bot);
  const link = await service.sendCode({ phone: '+998901234567' });
  await service.handleWebhook({ message: { from: { id: 42 }, chat: { id: 84 }, text: `/start ${link.linkToken}` } });
  assert.equal(pool.challenge.status, 'pending');
  assert.equal(bot.messages.length, 1);
  await service.handleWebhook({ message: { from: { id: 42 }, chat: { id: 84 }, text: `/start ${link.linkToken}` } });
  assert.equal(bot.messages.length, 1);
});

test('wrong OTP increments attempts and valid OTP completes login once', async () => {
  const pool = new FakePool({ id: 'client-1', telegram_user_id: '42', telegram_chat_id: '84', is_active: true });
  const bot = new FakeBot();
  const service = makeService(pool, bot);
  const { challenge_id: challengeId } = await service.sendCode({ phone: '+998901234567' });
  await assert.rejects(service.verifyCode({ challengeId, phone: '+998901234567', code: '000000' }), (error) => error.code === 'INVALID_CODE');
  const code = bot.messages[0].text.match(/(\d{6})$/)[1];
  const result = await service.verifyCode({ challengeId, phone: '+998901234567', code });
  assert.equal(result.verified, true);
  assert.equal(pool.challenge.status, 'verified');
  await assert.rejects(service.verifyCode({ challengeId, phone: '+998901234567', code }), (error) => error.code === 'VERIFICATION_SESSION_EXPIRED');
});

test('validation helpers enforce E.164 and exactly six OTP digits', () => {
  assert.equal(_internals.isValidE164('+998901234567'), true);
  assert.equal(_internals.isValidCode('123456'), true);
  assert.equal(_internals.isValidCode('12345'), false);
  assert.equal(_internals.isValidCode('1234567'), false);
});

test('missing Bot credentials fail closed before delivery', async () => {
  const pool = new FakePool({ id: 'client-1', telegram_user_id: '42', telegram_chat_id: '84', is_active: true });
  const service = new TelegramAuthService({ pool, env: { ...ENV, TELEGRAM_BOT_TOKEN: '' } });
  await assert.rejects(service.sendCode({ phone: '+998901234567' }), (error) => error.code === 'TELEGRAM_CODE_SEND_FAILED' || error.code === 'TELEGRAM_BOT_NOT_CONFIGURED');
});
