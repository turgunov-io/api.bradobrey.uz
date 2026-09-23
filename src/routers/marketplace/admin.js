const express = require('express');

const fraudAlerts = require('../../models/marketplace/fraudAlerts');
const settings = require('../../models/marketplace/settings');

const router = express.Router();

router.get('/fraud-alerts', (req, res, next) => fraudAlerts.list(req, res).catch(next));
router.patch('/fraud-alerts/:id', (req, res, next) => fraudAlerts.review(req, res).catch(next));
router.get('/settings', (req, res, next) => settings.list(req, res).catch(next));
router.patch('/settings/:key', (req, res, next) => settings.update(req, res).catch(next));

module.exports = router;
