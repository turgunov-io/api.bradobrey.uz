const express = require('express');

const { authenticateBarber } = require('../middleware/auth');
const {
  ensureBarberOwnsEntry,
  updateQueueEntry,
  swapOrReject,
  createPaymentRecord,
  computeAmountForEntry,
} = require('../services/queueService');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const { broadcastQueueUpdate } = require('../utils/realtime');

const paymentMethods = ['cash', 'card', 'certificate'];

const router = express.Router();

router.post(
  '/:id/call',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const entry = await ensureBarberOwnsEntry(req.params.id, req.user.barberId);

    if (!['waiting', 'called'].includes(entry.status)) {
      throw httpError(409, `Cannot call from status ${entry.status}`);
    }

    const updated = await updateQueueEntry(entry.id, { status: 'called' });

    broadcastQueueUpdate(req.app, {
      type: 'called',
      branchId: updated.branch_id,
      barberId: updated.barber_id,
      queueId: updated.id,
      status: updated.status,
    });

    res.json(updated);
  })
);

router.post(
  '/:id/start',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const entry = await ensureBarberOwnsEntry(req.params.id, req.user.barberId);

    if (!['called', 'waiting'].includes(entry.status)) {
      throw httpError(409, `Cannot start from status ${entry.status}`);
    }

    const updated = await updateQueueEntry(entry.id, {
      status: 'in_progress',
      started_at: new Date().toISOString(),
    });

    broadcastQueueUpdate(req.app, {
      type: 'in_progress',
      branchId: updated.branch_id,
      barberId: updated.barber_id,
      queueId: updated.id,
      status: updated.status,
    });

    res.json(updated);
  })
);

router.post(
  '/:id/reject',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const entry = await ensureBarberOwnsEntry(req.params.id, req.user.barberId);

    const result = await swapOrReject(entry);

    broadcastQueueUpdate(req.app, {
      type: result.action,
      branchId: result.updated.branch_id,
      barberId: result.updated.barber_id,
      queueId: result.updated.id,
      status: result.updated.status,
    });

    res.json(result);
  })
);

router.post(
  '/:id/complete',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const entry = await ensureBarberOwnsEntry(req.params.id, req.user.barberId);
    const { amount, method } = req.body || {};

    if (entry.status === 'completed') {
      throw httpError(409, 'Order already completed');
    }

    if (!paymentMethods.includes(method)) {
      throw httpError(
        400,
        `Payment method must be one of: ${paymentMethods.join(', ')}`
      );
    }

    const requestedAmount =
      typeof amount === 'number' && Number.isFinite(amount) ? amount : null;

    const { total } = await computeAmountForEntry(entry);
    const finalAmount = requestedAmount ?? total;

    if (!finalAmount || finalAmount <= 0) {
      throw httpError(
        400,
        'Payment amount must be positive (check service base_price or provide amount)'
      );
    }

    const updated = await updateQueueEntry(entry.id, {
      status: 'completed',
      finished_at: new Date().toISOString(),
    });

    const payment = await createPaymentRecord(entry.id, finalAmount, method);

    broadcastQueueUpdate(req.app, {
      type: 'completed',
      branchId: updated.branch_id,
      barberId: updated.barber_id,
      queueId: updated.id,
      status: updated.status,
    });

    res.json({ entry: updated, payment });
  })
);

router.post(
  '/:id/pause',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const entry = await ensureBarberOwnsEntry(req.params.id, req.user.barberId);

    // The schema does not allow a dedicated "paused" status; fallback to waiting.
    const updated = await updateQueueEntry(entry.id, {
      status: 'waiting',
      started_at: null,
    });

    broadcastQueueUpdate(req.app, {
      type: 'paused',
      branchId: updated.branch_id,
      barberId: updated.barber_id,
      queueId: updated.id,
      status: updated.status,
    });

    res.json(updated);
  })
);

module.exports = router;
