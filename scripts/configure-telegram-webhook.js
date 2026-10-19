require('dotenv').config();

const TelegramBotService = require('../src/services/telegram-bot.service');

const baseUrl = String(process.env.PUBLIC_BASE_URL || 'https://api.bradobrey.uz')
  .trim()
  .replace(/\/$/, '');
const webhookUrl = `${baseUrl}/api/integrations/telegram/webhook`;
const secretToken = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();

if (!secretToken) {
  console.error(JSON.stringify({ ok: false, failure: 'WEBHOOK_SECRET_MISSING' }));
  process.exit(1);
}

const bot = new TelegramBotService();

bot.setWebhook({
  url: webhookUrl,
  secretToken,
  allowedUpdates: ['message'],
})
  .then(() => bot.getWebhookInfo())
  .then((info) => {
    const result = {
      ok: true,
      webhookConfigured: Boolean(info.url),
      pendingUpdateCount: Number(info.pending_update_count || 0),
      lastErrorDate: info.last_error_date || null,
      lastErrorMessage: info.last_error_message || null,
    };
    console.log(JSON.stringify(result));
    if (!result.webhookConfigured || result.lastErrorDate) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, failure: error?.code || 'WEBHOOK_SETUP_FAILED' }));
    process.exit(1);
  });
