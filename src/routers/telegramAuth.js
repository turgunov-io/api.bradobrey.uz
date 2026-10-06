const crypto = require('node:crypto');
const express = require('express');

const TelegramAuth = require('../services/telegramAuth');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
const sendLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 3, keyPrefix: 'telegram-bot-send' });
const verifyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, keyPrefix: 'telegram-bot-verify' });

const handleError = (res, error) => {
  if (error?.expose && Number.isInteger(error.status)) return res.status(error.status).json({ error: error.message, code: error.code });
  console.error('[telegram-bot-auth] request failed', error?.code || 'UNKNOWN');
  return res.status(500).json({ error: 'Internal server error', code: 'TELEGRAM_AUTH_FAILED' });
};

const sendCode = async (req, res) => {
  try { return res.json(await TelegramAuth.sendCode({ phone: req.body?.phone })); }
  catch (error) { return handleError(res, error); }
};

const verifyCode = async (req, res) => {
  try {
    return res.json(await TelegramAuth.verifyCode({
      challengeId: req.body?.challenge_id,
      phone: req.body?.phone,
      code: req.body?.code,
      displayName: req.body?.display_name,
      firstName: req.body?.first_name,
      lastName: req.body?.last_name,
      language: req.body?.language,
    }));
  } catch (error) { return handleError(res, error); }
};

const hasWebhookSecret = (req) => {
  const configured = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  const supplied = String(req.get('x-telegram-bot-api-secret-token') || '');
  if (!configured || !supplied) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const webhook = async (req, res) => {
  if (!hasWebhookSecret(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    await TelegramAuth.handleWebhook(req.body);
  } catch (error) {
    // Telegram retries failed webhooks. Keep the endpoint quick and do not expose
    // linking/OTP or upstream details to Telegram.
    console.error('[telegram-bot-webhook] update failed', error?.code || 'UNKNOWN');
  }
  return res.sendStatus(200);
};

router.post('/send-code', sendLimiter, sendCode);
router.post('/link', sendLimiter, sendCode);
// Keep the previous marketplace route name as a non-breaking alias.
router.post('/request-code', sendLimiter, sendCode);
router.post('/verify-code', verifyLimiter, verifyCode);
router.post('/webhook', webhook);

module.exports = router;
module.exports.hasWebhookSecret = hasWebhookSecret;
module.exports.webhook = webhook;
