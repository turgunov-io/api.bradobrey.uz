const express = require('express');
const barbers = require('../models/barbers');
const telegramAuth = require('./telegramAuth');
const { rateLimit } = require('../middleware/rateLimit');

// Staff/admin password login is unauthenticated, so key strictly by IP.
// Requires TRUST_PROXY behind a reverse proxy, otherwise every client
// shares the proxy's address and therefore one bucket.
const STAFF_LOGIN_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'staff-login', keyBy: 'ip' };
const loginLimiter = rateLimit(STAFF_LOGIN_RATE_LIMIT);

const router = express.Router();

router.post('/login', loginLimiter, (req, res) => barbers.login(req, res));
router.use('/telegram', telegramAuth);

module.exports = router;
module.exports.STAFF_LOGIN_RATE_LIMIT = STAFF_LOGIN_RATE_LIMIT;
