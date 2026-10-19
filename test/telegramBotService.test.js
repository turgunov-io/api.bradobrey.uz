const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TelegramBotError,
  TelegramBotService,
} = require('../src/services/telegram-bot.service');

const ENV = {
  TELEGRAM_BOT_TOKEN: '123456789:bot-secret-value',
  TELEGRAM_BOT_USERNAME: 'shafotp_bot',
};

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

test('sends a Bot API request and checks the successful ok response', async () => {
  const calls = [];
  const service = new TelegramBotService({
    env: ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ ok: true, result: { message_id: 7 } });
    },
    logger: { info() {}, error() {} },
  });

  const result = await service.sendMessage('84', 'hello');

  assert.deepEqual(result, { message_id: 7 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.telegram\.org\/bot123456789:bot-secret-value\/sendMessage$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { chat_id: '84', text: 'hello' });
});

test('preserves Telegram upstream status, error code, description, and retry hint internally', async () => {
  const service = new TelegramBotService({
    env: ENV,
    fetchImpl: async () => response({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry later',
      parameters: { retry_after: 12 },
    }, 429),
    logger: { info() {}, error() {} },
  });

  await assert.rejects(
    service.sendMessage('84', 'hello'),
    (error) => {
      assert.ok(error instanceof TelegramBotError);
      assert.equal(error.code, 'UPSTREAM_REJECTED');
      assert.equal(error.status, 400);
      assert.equal(error.telegramErrorCode, 429);
      assert.equal(error.telegramDescription, 'Too Many Requests: retry later');
      assert.equal(error.retryAfter, 12);
      assert.equal(error.message, 'Telegram Bot API request failed');
      return true;
    },
  );
});

test('classifies an aborted request as a timeout', async () => {
  const service = new TelegramBotService({
    env: ENV,
    timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
    logger: { info() {}, error() {} },
  });

  await assert.rejects(
    service.sendMessage('84', 'hello'),
    (error) => error.code === 'TIMEOUT',
  );
});

test('structured logs never include the bot token or OTP text', async () => {
  const entries = [];
  const logger = {
    info(value) { entries.push(value); },
    error(value) { entries.push(value); },
  };
  const service = new TelegramBotService({
    env: ENV,
    fetchImpl: async () => response({ ok: true, result: { message_id: 1 } }),
    logger,
  });

  await service.sendMessage('84', '123456');

  const output = entries.join('\n');
  assert.doesNotMatch(output, /bot-secret-value/);
  assert.doesNotMatch(output, /123456/);
  assert.match(output, /bot_api_succeeded/);
});
