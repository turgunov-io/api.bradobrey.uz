const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

test('Telegram phone auth uses Bot API and keeps Gateway/MTProto out of the OTP flow', () => {
  const service = read('src/services/telegramAuth.js');
  const bot = read('src/services/telegram-bot.service.js');
  const router = read('src/routers/telegramAuth.js');
  const env = read('.env.example');
  assert.match(router, /router\.post\('\/send-code'/);
  assert.match(router, /router\.post\('\/verify-code'/);
  assert.match(router, /router\.post\('\/webhook'/);
  assert.match(bot, /api\.telegram\.org\/bot/);
  assert.match(service, /randomInt\(0, 1_000_000\)/);
  assert.match(service, /createHmac\('sha256'/);
  assert.doesNotMatch(service, /sendVerificationMessage|checkVerificationStatus|TelegramClient|StringSession|auth\.SignIn|auth\.sendCode|TELEGRAM_GATEWAY/);
  assert.match(env, /TELEGRAM_BOT_TOKEN=/);
  assert.match(env, /TELEGRAM_BOT_USERNAME=/);
  assert.match(env, /TELEGRAM_WEBHOOK_SECRET=/);
  assert.doesNotMatch(env, /TELEGRAM_GATEWAY|TELEGRAM_API_ID|TELEGRAM_API_HASH/);
});

test('Telegram Bot migration has binding, link-token and hash-only OTP fields', () => {
  const migration = read('db/postgres/marketplace_telegram_auth.sql');
  assert.match(migration, /telegram_user_id text/);
  assert.match(migration, /telegram_chat_id text/);
  assert.match(migration, /link_token_hash text/);
  assert.match(migration, /otp_hash text/);
  assert.match(migration, /max_attempts integer/);
  assert.match(migration, /expires_at timestamptz/);
  assert.doesNotMatch(migration, /otp_code text|code text/);
});
