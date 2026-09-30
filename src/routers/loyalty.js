const express = require('express');

const loyalty = require('../models/loyalty');

const router = express.Router();

// Admin-only endpoints (use /api/barbers/admin/login token)
router.get('/ranks', (req, res) => loyalty.getPublicRankSettings(req, res));
router.get('/ranks/settings', (req, res) => loyalty.getRankSettings(req, res));
router.patch('/ranks/settings', (req, res) => loyalty.updateRankSettings(req, res));

module.exports = router;

