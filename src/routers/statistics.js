const express = require('express');
const statistics = require('../models/statistics');
const employeeQuality = require('../models/employeeQuality');
const { authenticateStatistics, NETWORK_ROLES } = require('../utils/employeeQualityAccess');

const router = express.Router();

const protectLegacy = (mode) => async (req, res, next) => {
  try {
    const access = await authenticateStatistics(req, res, {
      requireRange: false,
      authorizeQuery: ({ query, role, user }) => {
        const authorized = { ...query };
        if (mode === 'global') authorized.scope = 'global';
        if (mode === 'branch') {
          authorized.scope = 'branch';
          authorized.branch_id = req.params.branch;
        }
        if (mode === 'manager') {
          authorized.scope = 'branch';
          authorized.branch_id = user.branch_id;
        }
        if (mode === 'employee') {
          const target = String(req.params.barber || '');
          if (String(user.id) === target) {
            authorized.scope = 'self';
          } else if (NETWORK_ROLES.has(role)) {
            authorized.scope = 'global';
            authorized.employee_id = target;
          } else {
            authorized.scope = 'branch';
            authorized.branch_id = user.branch_id;
            authorized.employee_id = target;
          }
        }
        return authorized;
      },
    });
    if (!access) return;
    req.statisticsAccess = access;
    next();
  } catch (error) {
    console.error('Legacy statistics authorization failed:', error.message);
    res.status(500).json({ error: 'Failed to authorize statistics request' });
  }
};

router.get('/employees', (req, res) => employeeQuality.aggregate(req, res));
router.get('/employees/:employeeId/orders', (req, res) => employeeQuality.orders(req, res));
router.patch('/employees/:employeeId/orders/:orderId/review', (req, res) => employeeQuality.review(req, res));

router.get('/barbers/:barber', protectLegacy('employee'), (req, res) => statistics.barber(req, res));
router.get('/branches/:branch', protectLegacy('branch'), (req, res) => statistics.branch(req, res));
router.get('/manager', protectLegacy('manager'), (req, res) => statistics.manager(req, res));
router.get('/', protectLegacy('global'), (req, res) => statistics.all(req, res));

module.exports = router;
