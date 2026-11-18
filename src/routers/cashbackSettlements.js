const express = require('express');

const settlements = require('../models/cashbackSettlements');
const { createAdminAuth } = require('../utils/adminAuth');
const reconciliation = require('../services/cashbackReconciliation');

const router = express.Router();

router.get('/', (req, res) => settlements.list(req, res));
router.patch('/:id', (req, res) => settlements.process(req, res));

// MULTI_TENANCY B2: role, archived state and company come from the DB
// (createAdminAuth), never from the token; reconciliation is per company.
const RECONCILIATION_ROLES = new Set(['admin_network', 'admin']);

function createReconciliationRoutes(router, {
  authorize = createAdminAuth({
    roles: RECONCILIATION_ROLES,
    forbiddenMessage: 'Only network admins can reconcile cashback',
  }),
  service = reconciliation,
} = {}) {
  const requireNetworkAdmin = async (req, res) => {
    const actor = await authorize(req, res);
    if (!actor) return null;
    if (!actor.companyId) {
      res.status(403).json({ code: 'COMPANY_REQUIRED', error: 'Company scope is required' });
      return null;
    }
    return actor;
  };

  router.get('/reconciliation/alerts', async (req, res, next) => {
    try {
      const actor = await requireNetworkAdmin(req, res);
      if (!actor) return;
      const alerts = await service.listReconciliationAlerts({
        status: String(req.query?.status || 'OPEN').toUpperCase(),
        limit: req.query?.limit,
        companyId: actor.companyId,
      });
      return res.json({ alerts });
    } catch (error) { return next(error); }
  });

  router.post('/reconciliation/run', async (req, res, next) => {
    try {
      const actor = await requireNetworkAdmin(req, res);
      if (!actor) return;
      const result = await service.reconcileCashbackBalances({
        actor: String(actor.sub || actor.id || 'admin'),
        companyId: actor.companyId,
      });
      return res.json(result);
    } catch (error) { return next(error); }
  });
  return router;
}

createReconciliationRoutes(router);

module.exports = router;
module.exports.createReconciliationRoutes = createReconciliationRoutes;
