const express = require('express');
const kiosk = require('../models/kiosk');

const router = express.Router();

const normalizeQueuePayload = (req, _res, next) => {
  if (req.body && req.body.customer_name === undefined && req.body.client_name !== undefined) {
    req.body.customer_name = req.body.client_name;
  }

  return next();
};

const withBranchParam = (req, res, next) => {
  const branchId = req.params.branch_id || req.query.branch_id;
  if (!branchId) return res.status(400).json({ error: 'branch_id is required' });

  req.params.branch_id = branchId;
  return next();
};

router.get('/barbers', withBranchParam, (req, res) => kiosk.barbers(req, res));
router.get('/barbers/:branch_id', withBranchParam, (req, res) => kiosk.barbers(req, res));
router.post('/queue', normalizeQueuePayload, (req, res) => kiosk.book(req, res));
router.get('/queue/:id/status', (req, res) => kiosk.queueStatus(req, res));
router.post('/queue/:id/cancel', (req, res) => kiosk.cancelQueue(req, res));

module.exports = router;
