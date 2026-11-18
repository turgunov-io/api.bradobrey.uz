const express = require('express');
const promo = require('../models/promocode');

const { staffAccess } = require('../middleware/staffAccess');

const router = express.Router();

// No app calls /validate or /use (kiosk bookings apply promo codes server-side),
// so they are limited to promo managers. The dashboard home page reads the
// list for any dashboard user; changes need promo.manage.
const canManage = staffAccess.requireStaff({ anyOf: ['promo.manage'] });
const canRead = staffAccess.requireStaff({ anyOf: ['promo.manage', 'dashboard.access'] });

router.post('/validate', canManage, (req, res) => promo.validate(req, res));
router.post('/use', canManage, (req, res) => promo.use(req, res));

router.get('/dashboard', canRead, (req, res) => promo.list(req, res));
router.get('/dashboard/:id', canRead, (req, res) => promo.stats(req, res));
router.post('/dashboard/create', canManage, (req, res) => promo.create(req, res));
router.patch('/dashboard/:id', canManage, (req, res) => promo.update(req, res));
router.delete('/dashboard/:id', canManage, (req, res) => promo.remove(req, res));

module.exports = router;
