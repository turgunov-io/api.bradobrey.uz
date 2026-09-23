const express = require('express');

const settlements = require('../models/cashbackSettlements');
const jwt = require('jsonwebtoken');
const reconciliation = require('../services/cashbackReconciliation');

const router = express.Router();

router.get('/', (req, res) => settlements.list(req, res));
router.patch('/:id', (req, res) => settlements.process(req, res));

function requireNetworkAdmin(req, res) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (!['admin_network', 'admin'].includes(payload?.role)) {
      res.status(403).json({ error: 'Only network admins can reconcile cashback' });
      return null;
    }
    return payload;
  } catch (_) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
}

router.get('/reconciliation/alerts', async (req, res, next) => {
  if (!requireNetworkAdmin(req, res)) return;
  try {
    const alerts = await reconciliation.listReconciliationAlerts({
      status: String(req.query?.status || 'OPEN').toUpperCase(),
      limit: req.query?.limit,
    });
    return res.json({ alerts });
  } catch (error) { return next(error); }
});

router.post('/reconciliation/run', async (req, res, next) => {
  const actor = requireNetworkAdmin(req, res);
  if (!actor) return;
  try {
    const result = await reconciliation.reconcileCashbackBalances({
      actor: String(actor.sub || actor.id || actor.login || 'admin'),
    });
    return res.json(result);
  } catch (error) { return next(error); }
});

module.exports = router;
