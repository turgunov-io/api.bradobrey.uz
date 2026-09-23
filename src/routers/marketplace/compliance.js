const express = require('express');
const compliance = require('../../models/marketplace/compliance');

const router = express.Router();
router.get('/active', (req, res, next) => compliance.activeBooking(req, res).catch(next));
router.get('/notifications', (req, res, next) => compliance.notifications(req, res).catch(next));
router.post('/notifications/:id/read', (req, res, next) => compliance.markNotificationRead(req, res).catch(next));
router.post('/push-tokens', (req, res, next) => compliance.registerPushToken(req, res).catch(next));
router.post('/:id/cancel', (req, res, next) => compliance.cancelBooking(req, res).catch(next));
router.get('/loyalty', (req, res, next) => compliance.loyalty(req, res).catch(next));
router.get('/referral', (req, res, next) => compliance.referral(req, res).catch(next));
router.post('/reviews', (req, res, next) => compliance.createReview(req, res).catch(next));

module.exports = router;
