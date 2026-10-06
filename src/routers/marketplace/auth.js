const express = require('express');

const MarketplaceAuth = require('../../models/marketplace/auth');
const TelegramAuth = require('../../services/telegramAuth');
const { rateLimit } = require('../../middleware/rateLimit');

const router = express.Router();

router.use(rateLimit({ windowMs: 60 * 60 * 1000, max: 10, keyPrefix: 'marketplace-auth' }));

router.post('/register', (req, res) => MarketplaceAuth.register(req, res));
router.post('/verify', (req, res) => MarketplaceAuth.verify(req, res));
router.post('/login', (req, res) => MarketplaceAuth.login(req, res));
router.post('/phone/request-otp', (req, res) => MarketplaceAuth.requestPhoneOtp(req, res));
router.post('/phone/verify', (req, res) => MarketplaceAuth.verifyPhone(req, res));

const handleTelegramError = (res, error) => {
  if (error?.expose && Number.isInteger(error.status)) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  // Do not log Telegram error messages: GramJS errors can contain sensitive
  // request context. Stable codes are enough for operational diagnostics.
  console.error('[marketplace-telegram-auth] request failed', error?.code || 'UNKNOWN');
  return res.status(500).json({ error: 'Internal server error', code: 'TELEGRAM_AUTH_FAILED' });
};

router.post('/telegram/request-code', async (req, res) => {
  try {
    return res.json(await TelegramAuth.requestCode({ phone: req.body?.phone }));
  } catch (error) {
    return handleTelegramError(res, error);
  }
});

router.post('/telegram/verify-code', async (req, res) => {
  try {
    return res.json(await TelegramAuth.verifyCode({
      challengeId: req.body?.challenge_id,
      code: req.body?.code,
      password: req.body?.password,
      displayName: req.body?.display_name,
      language: req.body?.language,
    }));
  } catch (error) {
    return handleTelegramError(res, error);
  }
});

module.exports = router;
