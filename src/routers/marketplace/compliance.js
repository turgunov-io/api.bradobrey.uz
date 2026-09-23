const express = require('express');
const compliance = require('../../models/marketplace/compliance');
const { rateLimit } = require('../../middleware/rateLimit');

const router = express.Router();
router.get('/active', (req, res, next) => compliance.activeBooking(req, res).catch((error) => {
  if (error?.code === '42P01' && String(error.message || '').includes('marketplace_bookings')) {
    return res.json({ booking: null, available: false });
  }
  return next(error);
}));
router.get('/notifications', (req, res, next) => compliance.notifications(req, res).catch(next));
router.post('/notifications/:id/read', (req, res, next) => compliance.markNotificationRead(req, res).catch(next));
router.post('/push-tokens', rateLimit({ windowMs: 60 * 60 * 1000, max: 10, keyPrefix: 'marketplace-push-token' }), (req, res, next) => compliance.registerPushToken(req, res).catch(next));
router.post('/:id/cancel', rateLimit({ windowMs: 60 * 60 * 1000, max: 10, keyPrefix: 'marketplace-cancel' }), (req, res, next) => compliance.cancelBooking(req, res).catch(next));
router.get('/loyalty', (req, res, next) => compliance.loyalty(req, res).catch(next));
router.get('/referral', (req, res, next) => compliance.referral(req, res).catch(next));
router.post('/reviews', rateLimit({ windowMs: 60 * 60 * 1000, max: 10, keyPrefix: 'marketplace-review' }), (req, res, next) => compliance.createReview(req, res).catch(next));

module.exports = router;
