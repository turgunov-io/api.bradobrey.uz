const { supabase } = require('../config/supabaseClient');
const httpError = require('../utils/httpError');

const queueSelectPrimary = `
  *,
  client:clients ( id, name, phone ),
  service:services ( id, name, duration_minutes, base_price )
`;

const queueSelectFallback = `
  id,
  client_id,
  branch_id,
  barber_id,
  service_id,
  source,
  status,
  created_at,
  started_at,
  finished_at,
  swapped_flag,
  client:clients ( id, name, phone ),
  service:services ( id, name, duration_minutes, base_price )
`;

const isMissingServiceIdsError = (error) =>
  Boolean(error?.message?.toLowerCase().includes('service_ids'));

const runQueueSelect = async (filters, { single = false } = {}) => {
  let primary = supabase.from('queue_entries').select(queueSelectPrimary);
  primary = filters(primary);

  let { data, error } = await (single ? primary.limit(1) : primary);

  if (error && isMissingServiceIdsError(error)) {
    let fallback = supabase.from('queue_entries').select(queueSelectFallback);
    fallback = filters(fallback);
    ({ data, error } = await (single ? fallback.limit(1) : fallback));
  }

  if (error) {
    throw httpError(500, error.message);
  }

  return single && Array.isArray(data) ? data[0] || null : data;
};

const allowedStatuses = [
  'waiting',
  'called',
  'swapped',
  'rejected',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
];

const assertStatusAllowed = (status) => {
  if (!allowedStatuses.includes(status)) {
    throw httpError(400, `Unsupported status: ${status}`);
  }
};

const fetchQueueEntry = async (id) => {
  const data = await runQueueSelect((q) => q.eq('id', id), { single: true });
  if (!data) {
    throw httpError(404, 'Queue entry not found');
  }
  return data;
};

const ensureBarberOwnsEntry = async (queueId, barberId) => {
  if (!barberId) {
    throw httpError(400, 'Barber profile is missing in the token payload');
  }

  const entry = await fetchQueueEntry(queueId);
  if (entry.barber_id !== barberId) {
    throw httpError(403, 'Entry does not belong to the current barber');
  }
  return entry;
};

const fetchQueueForBarber = async (
  barberId,
  statuses = ['waiting', 'called'],
  { fromDate, toDate } = {}
) => {
  const data = await runQueueSelect((q) => {
    let query = q
      .eq('barber_id', barberId)
      .in('status', statuses)
      .order('created_at', { ascending: true });

    if (fromDate) query = query.gte('created_at', fromDate);
    if (toDate) query = query.lte('created_at', toDate);

    return query;
  });
  return data;
};

const updateQueueEntry = async (id, payload) => {
  if (payload.status) {
    assertStatusAllowed(payload.status);
  }

  const { error } = await supabase
    .from('queue_entries')
    .update(payload)
    .eq('id', id);

  if (error) {
    throw httpError(500, error.message);
  }

  return fetchQueueEntry(id);
};

const findNextWaiting = async (barberId, createdAt) => {
  const data = await runQueueSelect(
    (q) =>
      q
        .eq('barber_id', barberId)
        .in('status', ['waiting', 'called'])
        .gt('created_at', createdAt)
        .order('created_at', { ascending: true })
        .limit(1),
    { single: true }
  );

  return data || null;
};

const swapOrReject = async (entry) => {
  if (!entry.swapped_flag) {
    const nextEntry = await findNextWaiting(entry.barber_id, entry.created_at);

    if (nextEntry) {
      const updated = await updateQueueEntry(entry.id, {
        swapped_flag: true,
        status: 'waiting',
        created_at: new Date(
          new Date(nextEntry.created_at).getTime() + 1000
        ).toISOString(),
      });

      return { action: 'swapped', updated, swappedWith: nextEntry };
    }
  }

  const rejected = await updateQueueEntry(entry.id, {
    status: 'rejected',
    finished_at: new Date().toISOString(),
  });

  return { action: 'rejected', updated: rejected };
};

const calculateWaitMinutes = async (barberId, targetEntryId) => {
  const selectPrimary = `
    id,
    status,
    created_at,
    service_id,
    service_ids,
    service:services ( duration_minutes )
  `;

  const selectFallback = `
    id,
    status,
    created_at,
    service_id,
    service:services ( duration_minutes )
  `;

  const run = async (select) =>
    supabase
      .from('queue_entries')
      .select(select)
      .eq('barber_id', barberId)
      .in('status', ['waiting', 'called', 'in_progress'])
      .order('created_at', { ascending: true });

  let { data, error } = await run(selectPrimary);
  if (error && isMissingServiceIdsError(error)) {
    ({ data, error } = await run(selectFallback));
  }

  if (error) {
    throw httpError(500, error.message);
  }

  // Preload durations for all service_ids used in queue
  const allServiceIds = new Set();
  (data || []).forEach((entry) => {
    const ids =
      Array.isArray(entry.service_ids) && entry.service_ids.length
        ? entry.service_ids
        : entry.service_id
          ? [entry.service_id]
          : [];
    ids.forEach((id) => allServiceIds.add(id));
  });

  const durationsById = new Map();
  if (allServiceIds.size) {
    const { data: services, error: servicesError } = await supabase
      .from('services')
      .select('id, duration_minutes')
      .in('id', Array.from(allServiceIds));

    if (servicesError) {
      throw httpError(500, servicesError.message);
    }

    (services || []).forEach((svc) => {
      durationsById.set(svc.id, Number(svc.duration_minutes || 0));
    });
  }

  const entryDuration = (entry) => {
    const ids =
      Array.isArray(entry.service_ids) && entry.service_ids.length
        ? entry.service_ids
        : entry.service_id
          ? [entry.service_id]
          : [];
    return ids.reduce((sum, id) => sum + (durationsById.get(id) || 0), 0);
  };

  let total = 0;
  for (const entry of data) {
    if (entry.id === targetEntryId) {
      return total;
    }
    total += entryDuration(entry);
  }

  return null;
};

const computeAmountForEntry = async (entry) => {
  const ids =
    Array.isArray(entry.service_ids) && entry.service_ids.length
      ? entry.service_ids
      : entry.service_id
        ? [entry.service_id]
        : [];

  if (!ids.length) {
    throw httpError(400, 'No services attached to this queue entry');
  }

  const { data: services, error } = await supabase
    .from('services')
    .select('id, base_price')
    .in('id', ids);

  if (error) {
    throw httpError(500, error.message);
  }

  if (!services || services.length !== ids.length) {
    throw httpError(400, 'One or more services for this entry no longer exist');
  }

  const total = services.reduce(
    (sum, svc) => sum + Number(svc.base_price || 0),
    0
  );

  return { total, services };
};

const createPaymentRecord = async (queueEntryId, amount, method) => {
  const { data, error } = await supabase
    .from('payments')
    .insert({ queue_entry_id: queueEntryId, amount, method })
    .select()
    .single();

  if (error) {
    throw httpError(500, error.message);
  }

  return data;
};

module.exports = {
  fetchQueueEntry,
  ensureBarberOwnsEntry,
  fetchQueueForBarber,
  updateQueueEntry,
  swapOrReject,
  calculateWaitMinutes,
  createPaymentRecord,
  computeAmountForEntry,
};
