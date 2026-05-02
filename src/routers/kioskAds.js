const express = require('express');

const kioskAds = require('../models/kioskAds');

const router = express.Router();

// Admin-only endpoints (use /api/barbers/admin/login token)
router.get('/settings', (req, res) => kioskAds.getSettings(req, res));
router.patch('/settings', (req, res) => kioskAds.updateSettings(req, res));

module.exports = router;

