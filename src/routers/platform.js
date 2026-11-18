const express = require('express');
const { platform, requirePlatformOwner } = require('../models/platform');
const { rateLimit } = require('../middleware/rateLimit');

// Password login is unauthenticated: key strictly by IP (same budget as staff login).
const PLATFORM_LOGIN_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'platform-login', keyBy: 'ip' };

const router = express.Router();

router.post('/login', rateLimit(PLATFORM_LOGIN_RATE_LIMIT), (req, res) => platform.login(req, res));
router.get('/companies', requirePlatformOwner, (req, res) => platform.listCompanies(req, res));
router.post('/companies', requirePlatformOwner, (req, res) => platform.createCompany(req, res));
router.patch('/companies/:id', requirePlatformOwner, (req, res) => platform.updateCompany(req, res));
router.post('/companies/:id/admins', requirePlatformOwner, (req, res) => platform.createCompanyAdmin(req, res));

module.exports = router;
module.exports.PLATFORM_LOGIN_RATE_LIMIT = PLATFORM_LOGIN_RATE_LIMIT;
