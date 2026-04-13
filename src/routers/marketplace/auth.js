const express = require('express');

const MarketplaceAuth = require('../../models/marketplace/auth');

const router = express.Router();

router.post('/register', (req, res) => MarketplaceAuth.register(req, res));
router.post('/verify', (req, res) => MarketplaceAuth.verify(req, res));
router.post('/login', (req, res) => MarketplaceAuth.login(req, res));

module.exports = router;
