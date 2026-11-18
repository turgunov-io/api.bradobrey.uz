const express = require('express');
const finance = require('../models/finance');

const { staffAccess } = require('../middleware/staffAccess');
const { attachBranchScope } = require('../utils/adminAuth');

const router = express.Router();

// Reads mirror the dashboard /finance page, limited to the caller's branches
// (network roles: whole network); writing a snapshot is admin-only.
const canRead = [
  staffAccess.requireStaff({
    anyOf: ['dashboard.access', 'statistics.read.branch', 'statistics.read.global'],
  }),
  attachBranchScope,
];

router.get('/overview', canRead, (req, res) => finance.overview(req, res));
router.get('/', canRead, (req, res) => finance.get(req, res));
router.post('/', staffAccess.requireSuperuser(), (req, res) => finance.upsert(req, res));

module.exports = router;
