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

const allowedMediaTypes = ['kids', 'ads', 'music', 'video'];

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

const loadServicesMap = async (serviceIds = []) => {
  const unique = Array.from(new Set(serviceIds)).filter(Boolean);
  if (!unique.length) return new Map();

  const { data, error } = await supabase
    .from('services')
    .select('id, name, duration_minutes, base_price')
    .in('id', unique);

  if (error) {
    throw httpError(500, error.message);
  }

  const map = new Map();
  (data || []).forEach((svc) => map.set(svc.id, svc));
  return map;
};

const loadLatestPayments = async (queueIds = []) => {
  const unique = Array.from(new Set(queueIds)).filter(Boolean);
  if (!unique.length) return new Map();

  const { data, error } = await supabase
    .from('payments')
    .select('queue_entry_id, method, amount, created_at')
    .in('queue_entry_id', unique)
    .order('created_at', { ascending: false });

  if (error) {
    throw httpError(500, error.message);
  }

  const map = new Map();
  (data || []).forEach((p) => {
    if (!map.has(p.queue_entry_id)) {
      map.set(p.queue_entry_id, p);
    }
  });
  return map;
};

const autoRejectStaleEntries = async (barberId, minutes = 10) => {
  if (!minutes || minutes <= 0) return [];
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('queue_entries')
    .update({
      status: 'rejected',
      finished_at: new Date().toISOString(),
    })
    .eq('barber_id', barberId)
    .in('status', ['waiting', 'called'])
    .lte('created_at', cutoff)
    .select('id, branch_id, barber_id, status');

  if (error) {
    throw httpError(500, error.message);
  }

  return data || [];
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
    let items = [];
    const barberId = req.user?.barberId || null;
    let query = supabase
      .from('media_assets')
      .select('id, type, title, url, mime_type, duration_seconds, is_active, barber_id, created_at, updated_at')
      .eq('type', category)
      .eq('is_active', true);

    if (barberId) {
      query = query.or(`barber_id.eq.${barberId},barber_id.is.null`);
    }

    const { data, error } = await query.order('created_at', { ascending: true });

    if (!error && Array.isArray(data)) {
      items = data;
    } else if (error && !/relation .* does not exist/i.test(error.message || '')) {
      throw httpError(500, error.message);
    }

    if (!items.length && staticMedia[category]) {
      items = staticMedia[category];
    }

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
    const timeoutMinutes = Number.isFinite(Number(req.query.timeout_minutes))
      ? Number(req.query.timeout_minutes)
      : 10;

    const autoRejected = await autoRejectStaleEntries(barberId, timeoutMinutes);
    autoRejected.forEach((entry) =>
      broadcastQueueUpdate(req.app, {
        type: 'rejected',
        branchId: entry.branch_id,
        barberId: entry.barber_id,
        queueId: entry.id,
        status: entry.status,
        reason: 'auto_timeout',
      })
    );

    // Use server-local calendar day (reduces "previous day" drift for UTC- offsets).
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

    const queue = await fetchQueueForBarber(barberId, ['waiting', 'called', 'in_progress'], {
      fromDate: startOfDay.toISOString(),
      toDate: endOfDay.toISOString(),
    });

    const queueIds = queue.map((q) => q.id);
    const allServiceIds = queue.flatMap((entry) => entryServiceIds(entry));
    const servicesMap = await loadServicesMap(allServiceIds);
    const paymentsMap = await loadLatestPayments(queueIds);

    const withEta = await Promise.all(
      queue.map(async (entry) => {
        const services = entryServiceIds(entry)
          .map((id) => servicesMap.get(id))
          .filter(Boolean);

        const totalPrice = services.reduce(
          (sum, svc) => sum + Number(svc?.base_price || 0),
          0
        );

        const lastPayment = paymentsMap.get(entry.id) || null;

        return {
          ...entry,
          services,
          total_price: totalPrice,
          payment_method: entry.payment_method || lastPayment?.method || null,
          last_payment: lastPayment,
          eta_minutes: await calculateWaitMinutes(barberId, entry.id),
        };
      })
    );

    res.json({ items: withEta, auto_rejected: autoRejected.map((e) => e.id) });
  })
);



router.post('/reject/user/:user_id', authenticateBarber, rejectByClient);
router.post('/reject/:user_id', authenticateBarber, rejectByClient);

router.post(
  '/shift/start',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const barberId = assertBarberInToken(req);
    const { branch_id: branchId } = req.body || {};

    const { data: barber, error } = await supabase
      .from('barbers')
      .update({
        is_on_shift: true,
        branch_id: branchId || null,
      })
      .eq('id', barberId)
      .select('id, name, branch_id, is_on_shift, is_authorized, specialization, photo_url')
      .maybeSingle();

    if (error) {
      throw httpError(500, error.message);
    }

    await supabase.from('users').update({ branch_id: branchId || barber?.branch_id || null }).eq('id', barberId);

    res.json({ barber, started_at: new Date().toISOString() });
  })
);

router.post(
  '/shift/stop',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const barberId = assertBarberInToken(req);

    const { data: barber, error } = await supabase
      .from('barbers')
      .update({ is_on_shift: false })
      .eq('id', barberId)
      .select('id, name, branch_id, is_on_shift, is_authorized, specialization, photo_url')
      .maybeSingle();

    if (error) {
      throw httpError(500, error.message);
    }

    res.json({ barber, stopped_at: new Date().toISOString() });
  })
);

router.post(
  '/queue/:id/swap',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const barberId = assertBarberInToken(req);
    const queueId = req.params.id;
    const { target_barber_id: targetBarberId, reason } = req.body || {};

    if (!targetBarberId) {
      throw httpError(400, 'target_barber_id is required');
    }

    const entry = await fetchQueueEntry(queueId);
    if (entry.barber_id !== barberId) {
      throw httpError(403, 'Entry does not belong to the current barber');
    }

    const { data: target, error: targetError } = await supabase
      .from('barbers')
      .select('id, branch_id, is_on_shift, is_authorized, name')
      .eq('id', targetBarberId)
      .maybeSingle();

    if (targetError) {
      throw httpError(500, targetError.message);
    }
    if (!target) {
      throw httpError(404, 'Target barber not found');
    }
    if (target.branch_id !== entry.branch_id) {
      throw httpError(400, 'Target barber must be in the same branch');
    }
    if (!target.is_on_shift || !target.is_authorized) {
      throw httpError(400, 'Target barber is not active/on shift');
    }

    const { data: updated, error: swapError } = await supabase
      .from('queue_entries')
      .update({
        barber_id: targetBarberId,
        status: 'waiting',
        swapped_flag: true,
      })
      .eq('id', queueId)
      .select()
      .maybeSingle();

    if (swapError) {
      throw httpError(500, swapError.message);
    }

    broadcastQueueUpdate(req.app, {
      type: 'swapped',
      branchId: updated.branch_id,
      barberId: targetBarberId,
      queueId: updated.id,
      status: updated.status,
      swapped_from: barberId,
      swapped_to: targetBarberId,
      reason: reason || null,
    });

    res.json({
      entry: updated,
      swapped_from: barberId,
      swapped_to: targetBarberId,
      reason: reason || null,
      target_barber: { id: target.id, name: target.name },
    });
  })
);

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
  '/history',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const barberId = assertBarberInToken(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const { data, error } = await supabase
      .from('queue_entries')
      .select(
        `
        id,
        status,
        created_at,
        finished_at,
        service_id,
        service_ids,
        payment_method,
        client:clients ( id, name, phone ),
        branch_id
      `
      )
      .eq('barber_id', barberId)
      .in('status', ['completed', 'cancelled', 'rejected', 'no_show', 'swapped'])
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw httpError(500, error.message);
    }

    const queueIds = (data || []).map((d) => d.id);
    const allServiceIds = (data || []).flatMap((entry) => entryServiceIds(entry));
    const servicesMap = await loadServicesMap(allServiceIds);
    const paymentsMap = await loadLatestPayments(queueIds);

    const items = (data || []).map((entry) => {
      const services = entryServiceIds(entry)
        .map((id) => servicesMap.get(id))
        .filter(Boolean);
      const totalPrice = services.reduce((sum, svc) => sum + Number(svc?.base_price || 0), 0);
      const lastPayment = paymentsMap.get(entry.id) || null;

      return {
        ...entry,
        services,
        total_price: totalPrice,
        payment_method: entry.payment_method || lastPayment?.method || null,
        last_payment: lastPayment,
      };
    });

    res.json({ items, count: items.length });
  })
);

router.get(
  '/profile',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const barberId = assertBarberInToken(req);

    const { data: barber, error: barberError } = await supabase
      .from('barbers')
      .select('id, name, phone, photo_url, branch_id, is_authorized, is_on_shift, specialization')
      .eq('id', barberId)
      .maybeSingle();

    if (barberError) {
      throw httpError(500, barberError.message);
    }

    if (!barber) {
      throw httpError(404, 'Barber profile not found');
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, login, role, branch_id')
      .eq('id', barberId)
      .maybeSingle();

    if (userError) {
      throw httpError(500, userError.message);
    }

    res.json({ barber, user });
  })
);

router.patch(
  '/profile',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const barberId = assertBarberInToken(req);
    const { name, specialization, photo_url: photoUrl, phone } = req.body || {};

    if (!name && !specialization && !photoUrl && !phone) {
      throw httpError(400, 'Provide at least one of name, specialization, photo_url, phone');
    }

    const payload = { updated_at: new Date().toISOString() };
    if (name) payload.name = name;
    if (specialization !== undefined) payload.specialization = specialization;
    if (photoUrl) payload.photo_url = photoUrl;
    if (phone) payload.phone = phone;

    const { data: barber, error } = await supabase
      .from('barbers')
      .update(payload)
      .eq('id', barberId)
      .select('id, name, phone, photo_url, branch_id, is_authorized, is_on_shift, specialization')
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

const normalizeMediaType = (value) => {
  if (!value) return null;
  const v = String(value).toLowerCase();
  if (v === 'musics') return 'music';
  if (v === 'videos') return 'video';
  if (allowedMediaTypes.includes(v)) return v;
  return null;
};

router.get(
  '/media',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const requestedType = normalizeMediaType(req.query.type);
    const barberId = req.user?.barberId || null;

    let query = supabase
      .from('media_assets')
      .select('id, type, title, url, mime_type, duration_seconds, is_active, barber_id, created_at, updated_at');

    if (requestedType) {
      query = query.eq('type', requestedType);
    }

    if (barberId) {
      query = query.or(`barber_id.eq.${barberId},barber_id.is.null`);
    }

    const { data, error } = await query.order('created_at', { ascending: true });

    if (error) {
      throw httpError(500, error.message);
    }

    res.json({
      items: data || [],
      count: Array.isArray(data) ? data.length : 0,
    });
  })
);

router.post(
  '/media',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const barberId = assertBarberInToken(req);
    const {
      type,
      title,
      url,
      mime_type: mimeType,
      duration_seconds: durationSeconds,
      is_active: isActive = true,
    } = req.body || {};

    const normalizedType = normalizeMediaType(type);
    if (!normalizedType) {
      throw httpError(400, `type must be one of: ${allowedMediaTypes.join(', ')} (musics maps to music)`);
    }

    if (!url) {
      throw httpError(400, 'url is required');
    }

    const insertPayload = {
      type: normalizedType,
      title: title || null,
      url,
      mime_type: mimeType || null,
      duration_seconds: typeof durationSeconds === 'number' ? durationSeconds : null,
      is_active: isActive !== false,
      barber_id: barberId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('media_assets')
      .insert(insertPayload)
      .select('id, type, title, url, mime_type, duration_seconds, is_active, created_at, updated_at')
      .single();

    if (error) {
      throw httpError(500, error.message);
    }

    res.status(201).json({ media: data });
  })
);

router.patch(
  '/media/:id',
  authenticateBarber,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const barberId = assertBarberInToken(req);
    const {
      type,
      title,
      url,
      mime_type: mimeType,
      duration_seconds: durationSeconds,
      is_active: isActive,
    } = req.body || {};

    const payload = { updated_at: new Date().toISOString() };

    if (type !== undefined) {
      const normalizedType = normalizeMediaType(type);
      if (!normalizedType) {
        throw httpError(400, `type must be one of: ${allowedMediaTypes.join(', ')} (musics maps to music)`);
      }
      payload.type = normalizedType;
    }

    if (title !== undefined) payload.title = title;
    if (url !== undefined) payload.url = url;
    if (mimeType !== undefined) payload.mime_type = mimeType;
    if (durationSeconds !== undefined) {
      payload.duration_seconds =
        typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
          ? durationSeconds
          : null;
    }
    if (isActive !== undefined) payload.is_active = Boolean(isActive);

    if (Object.keys(payload).length === 1) {
      throw httpError(400, 'No fields to update');
    }

    const { data: existing, error: existingError } = await supabase
      .from('media_assets')
      .select('id, barber_id')
      .eq('id', id)
      .maybeSingle();

    if (existingError) {
      throw httpError(500, existingError.message);
    }
    if (!existing) {
      throw httpError(404, 'Media item not found');
    }
    if (existing.barber_id && existing.barber_id !== barberId) {
      throw httpError(403, 'Cannot modify media owned by another barber');
    }

    const { data, error } = await supabase
      .from('media_assets')
      .update(payload)
      .eq('id', id)
      .select('id, type, title, url, mime_type, duration_seconds, is_active, created_at, updated_at')
      .maybeSingle();

    if (error) {
      throw httpError(500, error.message);
    }

    if (!data) {
      throw httpError(404, 'Media item not found');
    }

    res.json({ media: data });
  })
);

module.exports = router;
