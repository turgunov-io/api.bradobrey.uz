const express = require('express');

const { supabase } = require('../config/supabaseClient');
const { authenticateBarber } = require('../middleware/auth');
const {
  fetchQueueForBarber,
  calculateWaitMinutes,
  swapOrReject,
  fetchQueueEntry,
} = require('../services/queueService');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const { broadcastQueueUpdate } = require('../utils/realtime');

const router = express.Router();

const allStatuses = [
  'waiting',
  'called',
  'swapped',
  'rejected',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
];

const paymentMethods = ['cash', 'card', 'certificate'];

const staticMedia = {
  ads: [
    {
      id: 'ad-001',
      title: 'Weekend discount',
      url: 'https://cdn.example.com/media/ads/weekend-discount.mp4',
      type: 'video/mp4',
      duration_seconds: 30,
    },
    {
      id: 'ad-002',
      title: 'Care products bundle',
      url: 'https://cdn.example.com/media/ads/care-bundle.mp4',
      type: 'video/mp4',
      duration_seconds: 25,
    },
  ],
  kids: [
    {
      id: 'kids-001',
      title: 'Cartoon loop',
      url: 'https://cdn.example.com/media/kids/cartoon-loop.mp4',
      type: 'video/mp4',
      duration_seconds: 120,
    },
    {
      id: 'kids-002',
      title: 'Coloring calm',
      url: 'https://cdn.example.com/media/kids/coloring-calm.mp4',
      type: 'video/mp4',
      duration_seconds: 90,
    },
  ],
  music: [
    {
      id: 'music-001',
      title: 'Lounge playlist',
      url: 'https://cdn.example.com/media/music/lounge.m3u8',
      type: 'audio/m3u8',
      duration_seconds: null,
    },
    {
      id: 'music-002',
      title: 'Uplifting beats',
      url: 'https://cdn.example.com/media/music/uplifting.m3u8',
      type: 'audio/m3u8',
      duration_seconds: null,
    },
  ],
};

const assertBarberInToken = (req) => {
  if (!req.user.barberId) {
    throw httpError(400, 'Barber profile is missing in the token payload');
  }
  return req.user.barberId;
};

const buildStatusCounts = (entries = []) => {
  const counts = Object.fromEntries(allStatuses.map((s) => [s, 0]));
  entries.forEach((entry) => {
    if (counts[entry.status] !== undefined) {
      counts[entry.status] += 1;
    }
  });
  return counts;
};

const sumPaymentsForQueueIds = async (queueIds, { gteCreatedAt } = {}) => {
  if (!Array.isArray(queueIds) || queueIds.length === 0) {
    return 0;
  }

  let query = supabase
    .from('payments')
    .select('amount, created_at, queue_entry_id')
    .in('queue_entry_id', queueIds);

  if (gteCreatedAt) {
    query = query.gte('created_at', gteCreatedAt);
  }

  const { data, error } = await query;
  if (error) {
    throw httpError(500, error.message);
  }

  return (data || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
};

const findActiveEntryForClient = async (barberId, clientId) => {
  const { data, error } = await supabase
    .from('queue_entries')
    .select('id, status, created_at, swapped_flag, branch_id, barber_id')
    .eq('barber_id', barberId)
    .eq('client_id', clientId)
    .in('status', ['waiting', 'called', 'swapped'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw httpError(500, error.message);
  }

  return data || null;
};

const fetchClientById = async (clientId) => {
  if (!clientId) return null;
  const { data, error } = await supabase
    .from('clients')
    .select('id, name, phone, first_visit_date')
    .eq('id', clientId)
    .maybeSingle();

  if (error) {
    throw httpError(500, error.message);
  }
  return data || null;
};

const loadServicePrices = async (serviceIds = []) => {
  const unique = Array.from(new Set(serviceIds)).filter(Boolean);
  if (!unique.length) return new Map();

  const { data, error } = await supabase
    .from('services')
    .select('id, base_price')
    .in('id', unique);

  if (error) {
    throw httpError(500, error.message);
  }

  const map = new Map();
  (data || []).forEach((svc) => map.set(svc.id, Number(svc.base_price || 0)));
  return map;
};

const entryServiceIds = (entry) => {
  if (!entry) return [];
  if (Array.isArray(entry.service_ids) && entry.service_ids.length) {
    return entry.service_ids;
  }
  return entry.service_id ? [entry.service_id] : [];
};

const mediaHandler = (category) =>
  asyncHandler(async (req, res) => {
    const items = staticMedia[category] || [];
    res.json({
      category,
      items,
      count: items.length,
      generated_at: new Date().toISOString(),
    });
  });

  
const editClientHandler = asyncHandler(async (req, res) => {
  const barberId = assertBarberInToken(req);
  const clientId = req.params.user_id;
  const {
    name,
    phone,
    service_ids: serviceIdsInput,
    service_id: serviceIdInput,
    status,
    source,
    payment_method: paymentMethodInput,
  } = req.body || {};

  if (!clientId) {
    throw httpError(400, 'user_id param is required');
  }

  const hasClientChange = Boolean(name || phone);
  const serviceIds = Array.isArray(serviceIdsInput)
    ? serviceIdsInput
    : serviceIdInput
      ? [serviceIdInput]
      : [];

  if (!hasClientChange && !serviceIds.length && !status && !source && !paymentMethodInput) {
    throw httpError(400, 'Nothing to update. Provide client fields or queue fields.');
  }

  const activeEntry = await findActiveEntryForClient(barberId, clientId);
  if (!activeEntry) {
    throw httpError(404, 'Active queue entry for this user was not found for the current barber');
  }

  const queueId = activeEntry.id;

  if (paymentMethodInput && !paymentMethods.includes(paymentMethodInput)) {
    throw httpError(400, `payment_method must be one of: ${paymentMethods.join(', ')}`);
  }

  if (status && !allStatuses.includes(status)) {
    throw httpError(400, `Unsupported status: ${status}`);
  }

  if (phone) {
    const { data: existing, error: dupError } = await supabase
      .from('clients')
      .select('id')
      .eq('phone', phone)
      .neq('id', clientId)
      .maybeSingle();

    if (dupError) {
      throw httpError(500, dupError.message);
    }

    if (existing) {
      throw httpError(409, 'Phone is already registered to another client');
    }
  }

  const payload = {};
  if (name) payload.name = name;
  if (phone) payload.phone = phone;

  let client = null;
  if (hasClientChange) {
    const { data: updated, error: updateError } = await supabase
      .from('clients')
      .update(payload)
      .eq('id', clientId)
      .select('id, name, phone, first_visit_date')
      .maybeSingle();

    if (updateError) {
      throw httpError(500, updateError.message);
    }
    if (!updated) {
      throw httpError(404, 'Client not found');
    }
    client = updated;
  } else {
    client = await fetchClientById(clientId);
  }

  const queueUpdate = {};

  if (serviceIds.length) {
    const { data: services, error: servicesError } = await supabase
      .from('services')
      .select('id, is_active')
      .in('id', serviceIds);

    if (servicesError) {
      throw httpError(500, servicesError.message);
    }

    if (!services || services.length !== serviceIds.length) {
      throw httpError(400, 'One or more service_ids are invalid');
    }

    const inactive = services.find((s) => s.is_active === false);
    if (inactive) {
      throw httpError(400, `Service ${inactive.id} is not active`);
    }

    queueUpdate.service_ids = serviceIds;
    queueUpdate.service_id = serviceIds[0];
  }

  if (status) queueUpdate.status = status;
  if (source) queueUpdate.source = source;
  if (paymentMethodInput) queueUpdate.payment_method = paymentMethodInput;

  let updatedEntry = await fetchQueueEntry(queueId);

  if (Object.keys(queueUpdate).length) {
    let updateQuery = supabase.from('queue_entries').update(queueUpdate).eq('id', queueId);
    let { error: queueError } = await updateQuery;

    const isMissingPaymentMethod = (err) =>
      Boolean(err?.message?.toLowerCase().includes('payment_method'));

    if (queueError && isMissingPaymentMethod(queueError)) {
      const fallbackPayload = { ...queueUpdate };
      delete fallbackPayload.payment_method;
      ({ error: queueError } = await supabase
        .from('queue_entries')
        .update(fallbackPayload)
        .eq('id', queueId));
    }

    if (queueError) {
      throw httpError(500, queueError.message);
    }

    updatedEntry = await fetchQueueEntry(queueId);
  }

  let payment = null;
  if (paymentMethodInput) {
    const { data: existingPayment } = await supabase
      .from('payments')
      .select('id, amount, method, created_at')
      .eq('queue_entry_id', queueId)
      .maybeSingle();

    if (existingPayment) {
      const { data: updatedPayment, error: payError } = await supabase
        .from('payments')
        .update({ method: paymentMethodInput })
        .eq('id', existingPayment.id)
        .select('id, amount, method, created_at')
        .maybeSingle();

      if (payError) {
        throw httpError(500, payError.message);
      }
      payment = updatedPayment;
    }
  }

  res.json({
    client,
    entry: { ...updatedEntry, payment_method: paymentMethodInput || updatedEntry.payment_method },
    payment,
  });
});

const rejectByClient = asyncHandler(async (req, res) => {
  const barberId = assertBarberInToken(req);
  const clientId = req.params.user_id;
  const { reason } = req.body || {};

  if (!clientId) {
    throw httpError(400, 'user_id param is required');
  }

  const entry = await findActiveEntryForClient(barberId, clientId);
  if (!entry) {
    throw httpError(404, 'Active queue entry for this user was not found for the current barber');
  }

  const result = await swapOrReject(entry);
  const client = await fetchClientById(clientId);

  broadcastQueueUpdate(req.app, {
    type: result.action,
    branchId: result.updated.branch_id,
    barberId: result.updated.barber_id,
    queueId: result.updated.id,
    status: result.updated.status,
    reason: reason || null,
    client,
  });

  res.json({
    ...result,
    reject_reason: reason || null,
    client,
  });
});

router.get(
  '/queue',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const barberId = assertBarberInToken(req);

    // Use server-local calendar day (reduces "previous day" drift for UTC- offsets).
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

    const queue = await fetchQueueForBarber(barberId, ['waiting', 'called'], {
      fromDate: startOfDay.toISOString(),
      toDate: endOfDay.toISOString(),
    });

    const withEta = await Promise.all(
      queue.map(async (entry) => ({
        ...entry,
        eta_minutes: await calculateWaitMinutes(barberId, entry.id),
      }))
    );

    res.json({ items: withEta });
  })
);



router.post('/reject/user/:user_id', authenticateBarber, rejectByClient);
router.post('/reject/:user_id', authenticateBarber, rejectByClient);

router.patch('/edit/:user_id', authenticateBarber, editClientHandler);
router.patch('/edit/user/:user_id', authenticateBarber, editClientHandler);
router.patch('/edit/user/user/:user_id', authenticateBarber, editClientHandler);

router.get(
  '/statistics',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const barberId = assertBarberInToken(req);
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startIso = startOfDay.toISOString();

    const { data: todayEntries, error: todayError } = await supabase
      .from('queue_entries')
      .select('id, status, created_at, finished_at, service_id, service_ids')
      .eq('barber_id', barberId)
      .gte('created_at', startIso);

    if (todayError) {
      throw httpError(500, todayError.message);
    }

    const todayCounts = buildStatusCounts(todayEntries || []);
    const completedTodayIds = (todayEntries || [])
      .filter((entry) => entry.status === 'completed')
      .map((entry) => entry.id);

    const revenueToday = await sumPaymentsForQueueIds(completedTodayIds, {
      gteCreatedAt: startIso,
    });

    const { data: activeEntries, error: activeError } = await supabase
      .from('queue_entries')
      .select('status')
      .eq('barber_id', barberId)
      .in('status', ['waiting', 'called', 'in_progress']);

    if (activeError) {
      throw httpError(500, activeError.message);
    }

    const activeCounts = buildStatusCounts(activeEntries || []);

    const { count: totalCompleted, error: totalCompletedError } = await supabase
      .from('queue_entries')
      .select('id', { count: 'exact', head: true })
      .eq('barber_id', barberId)
      .eq('status', 'completed');

    if (totalCompletedError) {
      throw httpError(500, totalCompletedError.message);
    }

    const { data: completedAllEntries, error: completedAllError } = await supabase
      .from('queue_entries')
      .select('id')
      .eq('barber_id', barberId)
      .eq('status', 'completed');

    if (completedAllError) {
      throw httpError(500, completedAllError.message);
    }

    const lifetimeRevenue = await sumPaymentsForQueueIds(
      (completedAllEntries || []).map((entry) => entry.id)
    );

    const serviceIdsForToday = [];
    (todayEntries || []).forEach((entry) => {
      entryServiceIds(entry).forEach((id) => serviceIdsForToday.push(id));
    });
    const priceMap = await loadServicePrices(serviceIdsForToday);

    const priceForEntry = (entry) =>
      entryServiceIds(entry).reduce((sum, id) => sum + (priceMap.get(id) || 0), 0);

    const isPlanned = (entry) => !['cancelled', 'rejected', 'no_show'].includes(entry.status);

    const planTodayTotal = (todayEntries || [])
      .filter(isPlanned)
      .reduce((sum, entry) => sum + priceForEntry(entry), 0);

    const planRemaining = (todayEntries || [])
      .filter((entry) => isPlanned(entry) && entry.status !== 'completed')
      .reduce((sum, entry) => sum + priceForEntry(entry), 0);

    res.json({
      barber_id: barberId,
      range: { from: startIso, to: now.toISOString() },
      counts_today: todayCounts,
      active_counts: {
        waiting: activeCounts.waiting || 0,
        called: activeCounts.called || 0,
        in_progress: activeCounts.in_progress || 0,
      },
      revenue: {
        today: revenueToday,
        lifetime: lifetimeRevenue,
        currency: 'USD',
      },
      plan_today: {
        total: planTodayTotal,
        remaining: planRemaining,
        currency: 'USD',
      },
      totals: { completed: totalCompleted || 0 },
      generated_at: now.toISOString(),
    });
  })
);

router.get(
  '/photo',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const barberId = assertBarberInToken(req);

    const { data: barber, error } = await supabase
      .from('barbers')
      .select(
        'id, name, photo_url, branch_id, is_authorized, is_on_shift, specialization'
      )
      .eq('id', barberId)
      .maybeSingle();

    if (error) {
      throw httpError(500, error.message);
    }

    if (!barber) {
      throw httpError(404, 'Barber profile not found');
    }

    res.json({ barber });
  })
);

router.patch(
  '/photo',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const barberId = assertBarberInToken(req);
    const { photo_url: photoUrl } = req.body || {};

    if (!photoUrl) {
      throw httpError(400, 'photo_url is required');
    }

    const { data: barber, error } = await supabase
      .from('barbers')
      .update({ photo_url: photoUrl })
      .eq('id', barberId)
      .select(
        'id, name, photo_url, branch_id, is_authorized, is_on_shift, specialization'
      )
      .maybeSingle();

    if (error) {
      throw httpError(500, error.message);
    }

    if (!barber) {
      throw httpError(404, 'Barber profile not found');
    }

    res.json({ barber, updated_at: new Date().toISOString() });
  })
);

router.get('/media/ads', authenticateBarber, mediaHandler('ads'));
router.get('/media/kids', authenticateBarber, mediaHandler('kids'));
router.get('/media/music', authenticateBarber, mediaHandler('music'));

module.exports = router;
