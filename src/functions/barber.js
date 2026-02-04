const { supabase } = require('../config/supabaseClient');
const { swapOrReject, fetchQueueEntry } = require('../services/queueService');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const { broadcastQueueUpdate } = require('../utils/realtime');

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

const allowedMediaTypes = ['kids', 'ads', 'video'];

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

const normalizeMediaType = (value) => {
  if (!value) return null;
  const v = String(value).toLowerCase();
  if (v === 'musics') return 'music';
  if (v === 'videos') return 'video';
  if (allowedMediaTypes.includes(v)) return v;
  return null;
};

module.exports = {
  allStatuses,
  allowedMediaTypes,
  assertBarberInToken,
  autoRejectStaleEntries,
  buildStatusCounts,
  editClientHandler,
  entryServiceIds,
  fetchClientById,
  findActiveEntryForClient,
  loadLatestPayments,
  loadServicePrices,
  loadServicesMap,
  mediaHandler,
  normalizeMediaType,
  paymentMethods,
  rejectByClient,
  staticMedia,
  sumPaymentsForQueueIds,
};
