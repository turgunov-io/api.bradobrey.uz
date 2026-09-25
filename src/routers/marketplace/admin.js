const express = require('express');

const fraudAlerts = require('../../models/marketplace/fraudAlerts');
const settings = require('../../models/marketplace/settings');
const reports = require('../../models/marketplace/adminReports');

const router = express.Router();

router.get('/fraud-alerts', (req, res, next) => fraudAlerts.list(req, res).catch(next));
router.patch('/fraud-alerts/:id', (req, res, next) => fraudAlerts.review(req, res).catch(next));
router.get('/settings', (req, res, next) => settings.list(req, res).catch(next));
router.patch('/settings/:key', (req, res, next) => settings.update(req, res).catch(next));
router.get('/mobile-users', (req, res, next) => reports.listMobileUsers(req, res).catch(next));
router.post('/mobile-users/:id/test-notification', (req, res, next) => reports.sendTestNotification(req, res).catch(next));
router.get('/reviews', (req, res, next) => reports.listReviews(req, res).catch(next));

module.exports = router;
