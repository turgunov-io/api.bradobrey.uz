const express = require('express');

const { supabase } = require('../config/supabaseClient');
const { authenticateBarber } = require('../middleware/auth');
const {
  fetchQueueForBarber,
  calculateWaitMinutes,
  fetchQueueEntry,
} = require('../services/queueService');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const { broadcastQueueUpdate } = require('../utils/realtime');
const {
  allowedMediaTypes,
  assertBarberInToken,
  autoRejectStaleEntries,
  buildStatusCounts,
  editClientHandler,
  entryServiceIds,
  loadLatestPayments,
  loadServicePrices,
  loadServicesMap,
  mediaHandler,
  normalizeMediaType,
  rejectByClient,
  sumPaymentsForQueueIds,
} = require('../functions/barber');

const router = express.Router();

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

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

    const queue = await fetchQueueForBarber(barberId, ['waiting', 'called', 'in_progress'], {
      // fromDate: startOfDay.toISOString(),
      // toDate: endOfDay.toISOString(),
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

    const payload = {};
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

    res.json({ barber });
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

    res.json({ barber });
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

    const payload = {};

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
