const express = require('express');
const { companies } = require('../models/companies');
const { rateLimit } = require('../middleware/rateLimit');

// Unauthenticated company-code lookup: keyed strictly by IP so codes cannot
// be brute-forced quickly. Requires TRUST_PROXY behind a reverse proxy.
const COMPANY_RESOLVE_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 30, keyPrefix: 'company-resolve', keyBy: 'ip' };

const router = express.Router();

router.post('/resolve', rateLimit(COMPANY_RESOLVE_RATE_LIMIT), (req, res) => companies.resolve(req, res));

module.exports = router;
module.exports.COMPANY_RESOLVE_RATE_LIMIT = COMPANY_RESOLVE_RATE_LIMIT;
