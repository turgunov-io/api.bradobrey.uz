const express = require('express');
const kiosk = require('../models/kiosk');
const { kioskAuth } = require('../middleware/kioskAuth');

const router = express.Router();

// No known client calls /api/monitor; kiosk token only (no bearer bypass), so
// queue ids can only be read or cancelled within the kiosk's own branch.
const monitorAuth = kioskAuth();

const normalizeQueuePayload = (req, _res, next) => {
  if (req.body && req.body.customer_name === undefined && req.body.client_name !== undefined) {
    req.body.customer_name = req.body.client_name;
  }

  return next();
};

const withBranchParam = (req, res, next) => {
  const branchId = req.kiosk?.branchId || req.params.branch_id || req.query.branch_id;
  if (!branchId) return res.status(400).json({ error: 'branch_id is required' });

  req.params.branch_id = branchId;
  return next();
};

router.get('/barbers', monitorAuth, withBranchParam, (req, res) => kiosk.barbers(req, res));
router.get('/barbers/:branch_id', monitorAuth, withBranchParam, (req, res) => kiosk.barbers(req, res));
router.post('/queue', monitorAuth, normalizeQueuePayload, (req, res) => kiosk.book(req, res));
router.get('/queue/:id/status', monitorAuth, (req, res) => kiosk.queueStatus(req, res));
router.post('/queue/:id/cancel', monitorAuth, (req, res) => kiosk.cancelQueue(req, res));

module.exports = router;
