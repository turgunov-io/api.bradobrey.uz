const express = require('express');
const { platform, requirePlatformCompaniesManager, requirePlatformOwnersManager } = require('../models/platform');
const { rateLimit } = require('../middleware/rateLimit');

// Password login is unauthenticated: key strictly by IP (same budget as staff login).
const PLATFORM_LOGIN_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'platform-login', keyBy: 'ip' };

const router = express.Router();

router.post('/login', rateLimit(PLATFORM_LOGIN_RATE_LIMIT), (req, res) => platform.login(req, res));
// Companies and platform owners: the owner or an admin_network/admin of the
// active default company (DB-checked, management only — MULTI_TENANCY 12).
router.get('/companies', requirePlatformCompaniesManager, (req, res) => platform.listCompanies(req, res));
router.post('/companies', requirePlatformCompaniesManager, (req, res) => platform.createCompany(req, res));
router.patch('/companies/:id', requirePlatformCompaniesManager, (req, res) => platform.updateCompany(req, res));
router.post('/companies/:id/admins', requirePlatformCompaniesManager, (req, res) => platform.createCompanyAdmin(req, res));
router.get('/owners', requirePlatformOwnersManager, (req, res) => platform.listOwners(req, res));
router.post('/owners', requirePlatformOwnersManager, (req, res) => platform.createOwner(req, res));

module.exports = router;
module.exports.PLATFORM_LOGIN_RATE_LIMIT = PLATFORM_LOGIN_RATE_LIMIT;
