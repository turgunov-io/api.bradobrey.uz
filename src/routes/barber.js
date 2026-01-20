const express = require('express');

const { authenticateBarber } = require('../middleware/auth');
const {
  fetchQueueForBarber,
  calculateWaitMinutes,
} = require('../services/queueService');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');

const router = express.Router();

router.get(
  '/queue',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    if (!req.user.barberId) {
      throw httpError(400, 'Barber profile is missing in the token payload');
    }

    const queue = await fetchQueueForBarber(req.user.barberId, [
      'waiting',
      'called',
    ]);

    const withEta = await Promise.all(
      queue.map(async (entry) => ({
        ...entry,
        eta_minutes: await calculateWaitMinutes(
          req.user.barberId,
          entry.id
        ),
      }))
    );

    res.json({ items: withEta });
  })
);

module.exports = router;
