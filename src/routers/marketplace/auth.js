const express = require('express');

const MarketplaceAuth = require('../../models/marketplace/auth');
const { rateLimit } = require('../../middleware/rateLimit');

const router = express.Router();

router.use(rateLimit({ windowMs: 60 * 60 * 1000, max: 10, keyPrefix: 'marketplace-auth' }));

router.post('/register', (req, res) => MarketplaceAuth.register(req, res));
router.post('/verify', (req, res) => MarketplaceAuth.verify(req, res));
router.post('/login', (req, res) => MarketplaceAuth.login(req, res));
router.post('/phone/request-otp', (req, res) => MarketplaceAuth.requestPhoneOtp(req, res));
router.post('/phone/verify', (req, res) => MarketplaceAuth.verifyPhone(req, res));

module.exports = router;
