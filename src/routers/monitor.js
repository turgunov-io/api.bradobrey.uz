const express = require('express');
const kiosk = require('../models/kiosk');

const router = express.Router();

const withBranchParam = (req, res, next) => {
  const branchId = req.params.branch_id || req.query.branch_id;
  if (!branchId) return res.status(400).json({ error: 'branch_id is required' });

  req.params.branch_id = branchId;
  return next();
};

router.get('/barbers', withBranchParam, (req, res) => kiosk.barbers(req, res));
router.get('/barbers/:branch_id', withBranchParam, (req, res) => kiosk.barbers(req, res));
router.post('/queue', (req, res) => kiosk.book(req, res));

module.exports = router;
