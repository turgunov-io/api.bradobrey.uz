const test = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();

const { TelegramAuthService, _internals } = require('../src/services/telegramAuth');

const ENV = {
  TELEGRAM_BOT_TOKEN: 'bot-secret',
  TELEGRAM_BOT_USERNAME: 'bradobrey_bot',
  JWT_SECRET: 'jwt-secret',
  OTP_HASH_SECRET: 'otp-secret',
  JWT_EXPIRES_IN: '1h',
};

class FakeBot {
  constructor() { this.messages = []; }
  botUrl(token) { return `https://t.me/bradobrey_bot?start=${token}`; }
  async sendMessage(chatId, text, options) { this.messages.push({ chatId, text, options }); }
}

class FakePool {
  constructor(account = null) { this.account = account; this.challenge = null; this.historyCount = 0; this.ageSeconds = null; }
  async connect() { return { query: (sql, params) => this.execute(sql, params || []), release() {} }; }
  async query(sql, params) { return this.execute(sql, params || []); }
  async execute(sql, params) {
    const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] };
    if (q.startsWith('select count(*)')) return { rows: [{ count: this.rateCount ?? 0, age_seconds: this.rateAgeSeconds ?? null }] };
    if (q.startsWith('insert into telegram_auth_challenges')) {
      this.historyCount += 1;
      this.challenge = { challengeHash: params[0], phone: null, maxAttempts: params[1], attempts: 0, status: 'awaiting_telegram_link', linkHash: params[3], otpHash: null, telegramUserId: null, telegramChatId: null, usedAt: false, displayName: params[4], firstName: params[5], lastName: params[6], patronymic: params[7], referralCode: params[8], purpose: params[9], language: params[10] };
      return { rows: [] };
    }
    if (q.startsWith('select challenge_hash, phone, status')) {
      return this.challenge && !this.challenge.usedAt && this.challenge.linkHash === params[0] ? { rows: [{ challenge_hash: this.challenge.challengeHash, phone: this.challenge.phone, status: this.challenge.status, telegram_user_id: this.challenge.telegramUserId, telegram_chat_id: this.challenge.telegramChatId }] } : { rows: [] };
    }
    if (q.startsWith('select id, phone from marketplace_clients') || q.startsWith('select id, phone, is_active from marketplace_clients')) return { rows: this.account ? [this.account] : [] };
    if (q.startsWith('select phone from telegram_auth_challenges')) return { rows: [] };
    if (q.startsWith('select challenge_hash, phone, display_name')) {
      const usable = this.challenge && !this.challenge.usedAt && this.challenge.status === 'awaiting_contact' && String(this.challenge.telegramUserId) === String(params[0]) && String(this.challenge.telegramChatId) === String(params[1]);
      return usable ? { rows: [{ challenge_hash: this.challenge.challengeHash, phone: this.challenge.phone, display_name: this.challenge.displayName, first_name: this.challenge.firstName, last_name: this.challenge.lastName, patronymic: this.challenge.patronymic, referral_code: this.challenge.referralCode, purpose: this.challenge.purpose, language: this.challenge.language, telegram_user_id: this.challenge.telegramUserId, telegram_chat_id: this.challenge.telegramChatId, status: this.challenge.status, delivery_status: this.challenge.deliveryStatus }] } : { rows: [] };
    }
    if (q.startsWith('select challenge_hash, phone, otp_hash')) {
      const usable = this.challenge && !this.challenge.usedAt && this.challenge.status === 'pending';
      return usable ? { rows: [{ challenge_hash: this.challenge.challengeHash, phone: this.challenge.phone, otp_hash: this.challenge.otpHash, telegram_user_id: this.challenge.telegramUserId, telegram_chat_id: this.challenge.telegramChatId, attempts: this.challenge.attempts, max_attempts: this.challenge.maxAttempts, display_name: this.challenge.displayName, first_name: this.challenge.firstName, last_name: this.challenge.lastName, patronymic: this.challenge.patronymic, language: this.challenge.language }] } : { rows: [] };
    }
    if (q.startsWith('update telegram_auth_challenges set attempts')) { this.challenge.attempts += 1; return { rows: [] }; }
    if (q.startsWith('update telegram_auth_challenges set status = \'verified\'')) { this.challenge.status = 'verified'; this.challenge.usedAt = true; return { rows: [{ challenge_hash: this.challenge.challengeHash }] }; }
    if (q.startsWith('update telegram_auth_challenges set status = \'awaiting_contact\'')) { this.challenge.status = 'awaiting_contact'; this.challenge.telegramUserId = params[1]; this.challenge.telegramChatId = params[2]; return { rows: [] }; }
    if (q.startsWith('update telegram_auth_challenges set status = \'pending\'')) { this.challenge.status = 'pending'; this.challenge.phone = params[1]; this.challenge.otpHash = params[2]; return { rows: [] }; }
    if (q.startsWith('update telegram_auth_challenges set')) { if (q.includes('delivery_status')) this.challenge.deliveryStatus = params[0]; if (q.includes("status = 'failed'")) { this.challenge.status = 'failed'; this.challenge.usedAt = true; } return { rows: [] }; }
    if (q.startsWith('select id, email, phone')) return { rows: this.account ? [this.account] : [] };
    if (q.startsWith('select id from marketplace_clients')) return { rows: [] };
    if (q.startsWith('insert into marketplace_clients')) { this.account = { id: 'client-1', email: null, phone: params[0], display_name: params[1], first_name: params[2], last_name: params[3], patronymic: params[4], language: params[5] || 'ru', is_active: true, telegram_user_id: params[6], telegram_chat_id: params[7] }; return { rows: [this.account] }; }
    if (q.startsWith('update marketplace_clients')) return { rows: [this.account] };
    throw new Error(`Unexpected fake SQL: ${q}`);
  }
}

const makeService = (pool, bot = new FakeBot()) => new TelegramAuthService({ pool, botService: bot, env: ENV });

test('phone request creates an opaque Telegram session and stores no OTP', async () => {
  const pool = new FakePool();
  const result = await makeService(pool).sendCode({ firstName: 'Sardor', lastName: 'Test', patronymic: 'Owner' });
  assert.equal(result.requiresTelegram, true);
  assert.equal(result.sessionId, result.challenge_id);
  assert.match(result.linkToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(result.telegramUrl, /^https:\/\/t\.me\/bradobrey_bot\?start=/);
  assert.equal(result.expiresIn, 300);
  assert.equal(pool.challenge.otpHash, null);
  assert.equal(pool.challenge.patronymic, 'Owner');
});

test('start asks for phone, then sends a six-digit hash-only OTP with copy button', async () => {
  const pool = new FakePool(); const bot = new FakeBot(); const service = makeService(pool, bot);
  const link = await service.sendCode({ firstName: 'Sardor' });
  await service.handleWebhook({ message: { from: { id: 42 }, chat: { id: 84 }, text: `/start ${link.linkToken}` } });
  assert.equal(pool.challenge.status, 'awaiting_contact');
  assert.match(bot.messages[0].text, /поделиться номером телефона/);
  await service.handleWebhook({ message: { from: { id: 42 }, chat: { id: 84 }, contact: { user_id: 42, phone_number: '998901234567' } } });
  assert.equal(pool.challenge.status, 'pending');
  const code = bot.messages[1].text.match(/\b(\d{6})\b/)[1];
  assert.match(code, /^\d{6}$/);
  assert.equal(bot.messages[1].options.reply_markup.inline_keyboard[0][0].copy_text.text, code);
  assert.equal(pool.challenge.otpHash, new TelegramAuthService({ env: ENV }).hashOtp(code));
  assert.equal(pool.challenge.otpHash.includes(code), false);
});

test('wrong Telegram phone does not generate an OTP', async () => {
  const pool = new FakePool(); const bot = new FakeBot(); const service = makeService(pool, bot);
  const link = await service.sendCode({});
  await service.handleWebhook({ message: { from: { id: 42 }, chat: { id: 84 }, text: `/start ${link.linkToken}` } });
  await service.handleWebhook({ message: { from: { id: 42 }, chat: { id: 84 }, contact: { user_id: 99, phone_number: '+998901234568' } } });
  assert.equal(pool.challenge.status, 'awaiting_contact');
  assert.equal(pool.challenge.otpHash, null);
  assert.match(bot.messages.at(-1).text, /чужой контакт/);
});

test('existing Telegram binding can start a new login session', async () => {
  const pool = new FakePool({ id: 'client-1', phone: '+998901234567', telegram_user_id: '42', telegram_chat_id: '84', is_active: true });
  const bot = new FakeBot(); const service = makeService(pool, bot);
  const link = await service.sendCode({});
  await service.handleWebhook({ message: { from: { id: 42 }, chat: { id: 84 }, text: `/start ${link.linkToken}` } });
  assert.equal(pool.challenge.status, 'awaiting_contact');
  assert.doesNotMatch(bot.messages.at(-1).text, /Ссылка недействительна/);
  await service.handleWebhook({ message: { from: { id: 42 }, chat: { id: 84 }, contact: { user_id: 42, phone_number: '998901234567' } } });
  assert.equal(pool.challenge.status, 'pending');
});

test('wrong OTP increments attempts and valid OTP completes login once', async () => {
  const pool = new FakePool(); const bot = new FakeBot(); const service = makeService(pool, bot);
  const { challenge_id: challengeId, linkToken } = await service.sendCode({});
  await service.handleWebhook({ message: { from: { id: 42 }, chat: { id: 84 }, text: `/start ${linkToken}` } });
  await service.handleWebhook({ message: { from: { id: 42 }, chat: { id: 84 }, contact: { user_id: 42, phone_number: '+998901234567' } } });
  await assert.rejects(service.verifyCode({ challengeId, phone: '+998901234567', code: '000000' }), (error) => error.code === 'INVALID_CODE');
  const code = bot.messages[1].text.match(/\b(\d{6})\b/)[1];
  const result = await service.verifyCode({ challengeId, phone: '+998901234567', code });
  assert.equal(result.verified, true);
  assert.equal(pool.challenge.status, 'verified');
  await assert.rejects(service.verifyCode({ challengeId, phone: '+998901234567', code }), (error) => error.code === 'VERIFICATION_SESSION_EXPIRED');
});

test('second request is progressively rate limited for 60 seconds', async () => {
  const pool = new FakePool(); const bot = new FakeBot(); const service = makeService(pool, bot);
  const link = await service.sendCode({});
  await service.handleWebhook({ message: { from: { id: 42 }, chat: { id: 84 }, text: `/start ${link.linkToken}` } });
  pool.rateCount = 1;
  pool.rateAgeSeconds = 0;
  await service.handleWebhook({ message: { from: { id: 42 }, chat: { id: 84 }, contact: { user_id: 42, phone_number: '+998901234567' } } });
  assert.match(bot.messages.at(-1).text, /через 60/);
});

test('validation helpers enforce E.164 and exactly six OTP digits', () => {
  assert.equal(_internals.normalizePhone('998 90 123 45 67'), '+998901234567');
  assert.equal(_internals.normalizePhone('00998901234567'), '+998901234567');
  assert.equal(_internals.isValidE164('+998901234567'), true);
  assert.equal(_internals.isValidCode('123456'), true);
  assert.equal(_internals.isValidCode('12345'), false);
  assert.equal(_internals.isValidCode('1234567'), false);
});

test('missing Bot credentials fail closed before delivery', async () => {
  const pool = new FakePool();
  const service = new TelegramAuthService({ pool, env: { ...ENV, TELEGRAM_BOT_TOKEN: '' } });
  await assert.rejects(service.sendCode({ phone: '+998901234567' }), (error) => error.code === 'TELEGRAM_BOT_NOT_CONFIGURED');
});
