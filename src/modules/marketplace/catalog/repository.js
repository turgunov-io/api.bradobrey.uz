const { supabase } = require('../../../config/supabase');
const { OPERATIONAL_BARBER_ROLES, ACTIVE_QUEUE_STATUSES } = require('./constants');
const {
  isMissingColumnError,
  isMissingRelationError,
  normalizeText,
} = require('./helpers');

const getBranch = async (branchId) => {
  let { data, error } = await supabase
    .from('branches')
    .select('id, name, address, city, work_hours, timezone, is_active, marketplace_barbershop_id')
    .eq('id', branchId)
    .maybeSingle();

  if (isMissingColumnError(error, 'marketplace_barbershop_id')) {
    ({ data, error } = await supabase
      .from('branches')
      .select('id, name, address, city, work_hours, timezone, is_active')
      .eq('id', branchId)
      .maybeSingle());

    if (data) data.marketplace_barbershop_id = null;
  }

  return { data, error };
};

const getActiveServices = async () => {
  const { data, error } = await supabase
    .from('services')
    .select('id, name, duration_minutes, base_price, category, is_active')
    .eq('is_active', true)
    .order('category', { ascending: true, nullsFirst: false })
    .order('base_price', { ascending: true })
    .order('name', { ascending: true });

  if (error) throw error;
  return data || [];
};

const getBranchOperationalBarbers = async (branchId) => {
  const { data: barbers, error: barbersError } = await supabase
    .from('barbers')
    .select('id, name, branch_id, photo_url, specialization, is_on_shift, is_active')
    .eq('branch_id', branchId);

  if (barbersError) throw barbersError;

  const barberIds = (barbers || []).map((barber) => barber?.id).filter(Boolean);
  if (!barberIds.length) return [];

  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('id, role')
    .in('id', barberIds)
    .in('role', OPERATIONAL_BARBER_ROLES);

  if (usersError) throw usersError;

  const allowedBarberIds = new Set((users || []).map((user) => user?.id));
  const visibleBarbers = (barbers || []).filter((barber) => (
    allowedBarberIds.has(barber?.id) && barber?.is_active !== false
  ));

  const { data: queues, error: queueError } = await supabase
    .from('queue_entries')
    .select('id, barber_id, service_id, service_ids, status')
    .eq('branch_id', branchId)
    .in('status', ACTIVE_QUEUE_STATUSES);

  if (queueError) throw queueError;

  const activeQueues = (queues || []).filter((entry) => allowedBarberIds.has(entry?.barber_id));

  const serviceIds = Array.from(new Set(
    activeQueues.flatMap((entry) => (
      Array.isArray(entry?.service_ids) && entry.service_ids.length
        ? entry.service_ids
        : [entry?.service_id]
    )).filter(Boolean)
  ));

  let serviceDurationById = new Map();
  if (serviceIds.length) {
    const { data: services, error: servicesError } = await supabase
      .from('services')
      .select('id, duration_minutes')
      .in('id', serviceIds);

    if (servicesError) throw servicesError;
    serviceDurationById = new Map((services || []).map((service) => [
      String(service?.id),
      Number(service?.duration_minutes || 0),
    ]));
  }

  const waitingByBarber = new Map();
  const queueCountByBarber = new Map();

  for (const entry of activeQueues) {
    const key = String(entry?.barber_id);
    const entryServiceIds = Array.isArray(entry?.service_ids) && entry.service_ids.length
      ? entry.service_ids
      : [entry?.service_id];

    const duration = (entryServiceIds || []).reduce((sum, serviceId) => (
      sum + (serviceDurationById.get(String(serviceId)) || 0)
    ), 0);

    waitingByBarber.set(key, (waitingByBarber.get(key) || 0) + duration);
    queueCountByBarber.set(key, (queueCountByBarber.get(key) || 0) + 1);
  }

  return visibleBarbers
    .map((barber) => ({
      id: barber.id,
      name: barber.name,
      photo_url: barber.photo_url || null,
      specialization: barber.specialization || null,
      branch_id: barber.branch_id,
      is_on_shift: barber.is_on_shift === true,
      is_active: barber.is_active !== false,
      queue_count: queueCountByBarber.get(String(barber.id)) || 0,
      estimated_waiting_time: waitingByBarber.get(String(barber.id)) || 0,
    }))
    .sort((left, right) => {
      if (left.is_on_shift !== right.is_on_shift) return left.is_on_shift ? -1 : 1;
      if (left.estimated_waiting_time !== right.estimated_waiting_time) {
        return left.estimated_waiting_time - right.estimated_waiting_time;
      }
      return String(left.name || '').localeCompare(String(right.name || ''));
    });
};

const listMarketplaceBarbershops = async ({ active, city } = {}) => {
  let query = supabase
    .from('marketplace_barbershops')
    .select('id, name, description, logo_url, cover_url, city, address, work_hours, timezone, is_active, sort_order, metadata');

  if (active !== null && active !== undefined) query = query.eq('is_active', active);

  const normalizedCity = normalizeText(city);
  if (normalizedCity) {
    // Case-insensitive exact match (ILIKE without wildcards behaves like equals)
    query = query.ilike('city', normalizedCity);
  }

  const { data, error } = await query
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  return { data, error };
};

const getMarketplaceBarbershopById = async (id) => supabase
  .from('marketplace_barbershops')
  .select('id, name, description, logo_url, cover_url, city, address, work_hours, timezone, is_active, sort_order, metadata')
  .eq('id', id)
  .maybeSingle();

const listBranchesForBarbershop = async (barbershopId, { active } = {}) => {
  let query = supabase
    .from('branches')
    .select('id, name, address, city, work_hours, timezone, is_active, marketplace_barbershop_id')
    .eq('marketplace_barbershop_id', barbershopId);

  if (active !== null && active !== undefined) query = query.eq('is_active', active);

  const { data, error } = await query.order('name', { ascending: true });
  return { data, error };
};

const listAllBranchesMarketplaceLinks = async () => supabase
  .from('branches')
  .select('id, marketplace_barbershop_id, is_active');

const listActiveCertificates = async () => supabase
  .from('certificates')
  .select('id, code, service_ids, expires_at, is_used, metadata, marketplace_barbershop_id')
  .eq('is_used', false)
  .order('code', { ascending: true });

const listActiveCertificatesFallback = async () => supabase
  .from('certificates')
  .select('id, code, service_ids, expires_at, is_used, metadata')
  .eq('is_used', false)
  .order('code', { ascending: true });

const fetchPromoCode = async (code) => supabase
  .from('promo_codes')
  .select('*')
  .eq('code', code)
  .maybeSingle();

const fetchCertificateByCode = async (code) => supabase
  .from('certificates')
  .select('id, code, expires_at, is_used, metadata, service_ids, marketplace_barbershop_id')
  .eq('code', code)
  .maybeSingle();

const fetchCertificateByCodeFallback = async (code) => supabase
  .from('certificates')
  .select('id, code, expires_at, is_used, metadata, service_ids')
  .eq('code', code)
  .maybeSingle();

const fetchServicesByIds = async (serviceIds) => supabase
  .from('services')
  .select('id, name, duration_minutes, base_price, category, is_active')
  .in('id', serviceIds);

const fetchBarberById = async (barberId) => supabase
  .from('barbers')
  .select('id, name, branch_id, is_active, is_on_shift')
  .eq('id', barberId)
  .maybeSingle();

const fetchBarberUserRole = async (barberId) => supabase
  .from('users')
  .select('id, role')
  .eq('id', barberId)
  .in('role', OPERATIONAL_BARBER_ROLES)
  .maybeSingle();

const fetchBranchScheduleForDay = async ({ branchId, dayOfWeek, barberId, localDate }) => {
  // Fetch both personal (barber_id) and branch default (barber_id is null),
  // then pick the best match in JS to avoid complex PostgREST boolean logic.
  const { data: rows, error } = await supabase
    .from('barber_work_schedules')
    .select('id, branch_id, barber_id, day_of_week, start_time, end_time, grace_minutes, is_active, valid_from, valid_to')
    .eq('branch_id', branchId)
    .eq('day_of_week', dayOfWeek)
    .eq('is_active', true)
    .or(`barber_id.eq.${barberId},barber_id.is.null`)
    .order('valid_from', { ascending: false });

  if (error && isMissingRelationError(error, 'barber_work_schedules')) {
    return { data: null, error };
  }
  if (error) return { data: null, error };

  const local = String(localDate || '').trim();
  const isValidForDate = (row) => {
    if (!local) return true;
    const from = row?.valid_from ? String(row.valid_from) : null;
    const to = row?.valid_to ? String(row.valid_to) : null;
    if (from && from > local) return false;
    if (to && to < local) return false;
    return true;
  };

  const candidates = (rows || []).filter(isValidForDate);
  const personal = candidates.find((row) => String(row?.barber_id || '') === String(barberId));
  if (personal) return { data: personal, error: null };

  const branchDefault = candidates.find((row) => row?.barber_id === null);
  if (branchDefault) return { data: branchDefault, error: null };

  return { data: null, error: null };
};

const fetchScheduledQueueEntriesForBarberDay = async ({ barberId, dayStartIso, dayEndIso }) => {
  const { data, error } = await supabase
    .from('queue_entries')
    .select('id, barber_id, status, scheduled_start_at, scheduled_end_at')
    .eq('barber_id', barberId)
    .gte('scheduled_start_at', dayStartIso)
    .lt('scheduled_start_at', dayEndIso)
    .in('status', ['waiting', 'called', 'swapped', 'in_progress'])
    .order('scheduled_start_at', { ascending: true });

  if (error && isMissingColumnError(error, 'scheduled_start_at')) {
    return { data: [], error: null, setup_required: true };
  }

  return { data: data || [], error, setup_required: false };
};

module.exports = {
  getBranch,
  getActiveServices,
  getBranchOperationalBarbers,
  listMarketplaceBarbershops,
  getMarketplaceBarbershopById,
  listBranchesForBarbershop,
  listAllBranchesMarketplaceLinks,
  listActiveCertificates,
  listActiveCertificatesFallback,
  fetchPromoCode,
  fetchCertificateByCode,
  fetchCertificateByCodeFallback,
  fetchServicesByIds,
  fetchBarberById,
  fetchBarberUserRole,
  fetchBranchScheduleForDay,
  fetchScheduledQueueEntriesForBarberDay,
};
