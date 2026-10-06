const DEFAULT_TIMEOUT_MS = 8 * 1000;

class TelegramBotError extends Error {
  constructor(code, status = 502) {
    super('Telegram Bot API request failed');
    this.name = 'TelegramBotError';
    this.code = String(code || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 80);
    this.status = status;
  }
}

class TelegramBotService {
  constructor({ fetchImpl = globalThis.fetch, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.fetchImpl = fetchImpl;
    this.env = env;
    this.timeoutMs = timeoutMs;
  }

  getConfig() {
    const token = String(this.env.TELEGRAM_BOT_TOKEN || '').trim();
    const username = String(this.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
    if (!token || !/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new TelegramBotError('BOT_NOT_CONFIGURED', 503);
    return { token, username };
  }

  async request(method, payload = {}) {
    const { token } = this.getConfig();
    if (typeof this.fetchImpl !== 'function') throw new TelegramBotError('FETCH_UNAVAILABLE', 503);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response;
      try {
        response = await this.fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal,
        });
      } catch (_) { throw new TelegramBotError('NETWORK_FAILURE'); }
      let body;
      try { body = await response.json(); } catch (_) { throw new TelegramBotError('INVALID_RESPONSE'); }
      if (!response.ok || !body?.ok) throw new TelegramBotError('UPSTREAM_REJECTED', response.status >= 500 ? 502 : 400);
      return body.result || {};
    } finally { clearTimeout(timeout); }
  }

  async sendMessage(chatId, text, options = {}) {
    if (!chatId || !text) throw new TelegramBotError('INVALID_MESSAGE', 400);
    return this.request('sendMessage', { chat_id: String(chatId), text, ...options });
  }

  async setWebhook({ url, secretToken, allowedUpdates = ['message'] }) {
    if (!url || !secretToken) throw new TelegramBotError('WEBHOOK_NOT_CONFIGURED', 503);
    return this.request('setWebhook', { url, secret_token: secretToken, allowed_updates: allowedUpdates });
  }

  async deleteWebhook() { return this.request('deleteWebhook', {}); }
  async getWebhookInfo() { return this.request('getWebhookInfo', {}); }

  botUrl(linkToken) {
    const { username } = this.getConfig();
    return `https://t.me/${username}?start=${encodeURIComponent(linkToken)}`;
  }
}

module.exports = TelegramBotService;
module.exports.TelegramBotService = TelegramBotService;
module.exports.TelegramBotError = TelegramBotError;
