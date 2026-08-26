const { applyPromoDiscount, roundMoney } = require('../../../composable/cashback');
const { PAYMENT_METHODS } = require('./constants');
const {
  groupServicesByCategory,
  isMissingColumnError,
  isMissingRelationError,
  isRealMarketplaceBarbershop,
  normalizeCode,
  normalizeId,
  normalizeText,
} = require('./helpers');
const repo = require('./repository');
const {
  addDaysToDateString,
  getZonedDateString,
  getZonedWeekdayIndex,
  parseHHMM,
  zonedDateTimeToUtc,
} = require('./time');

const DEFAULT_TIMEZONE = 'Asia/Tashkent';
const SLOT_INTERVAL_MINUTES = 15;

const formatBarbershop = (row, branchesCount = 0) => ({
  id: row.id,
  name: row.name,
  description: row.description || null,
  logo_url: row.logo_url || null,
  cover_url: row.cover_url || null,
  city: row.city || null,
  address: row.address || null,
  work_hours: row.work_hours || null,
  timezone: row.timezone || null,
  is_active: row.is_active !== false,
  sort_order: Number(row.sort_order || 0),
  branches_count: branchesCount,
  metadata: row.metadata || {},
});

const isScopedToDifferentBarbershop = (benefit, branch) => (
  Boolean(benefit?.marketplace_barbershop_id) &&
  benefit.marketplace_barbershop_id !== branch?.marketplace_barbershop_id
);

const validatePromo = async ({ code, total, branch }) => {
  const normalizedCode = normalizeCode(code);
  if (!normalizedCode) return { promo: null, discountedTotal: roundMoney(total) };

  const { data: promo, error } = await repo.fetchPromoCode(normalizedCode);
  if (error) throw error;

  if (!promo) {
    const err = new Error('Promo code not found');
    err.statusCode = 404;
    throw err;
  }

  if (promo.status !== 'active') {
    const err = new Error('Promo code inactive');
    err.statusCode = 400;
    throw err;
  }

  if (!promo.is_unlimited) {
    const used = Number(promo.used_count || 0);
    const limit = Number(promo.usage_limit || 0);
    if (used >= limit) {
      const err = new Error('Promo code expired or limit reached');
      err.statusCode = 400;
      throw err;
    }
  }

  if (isScopedToDifferentBarbershop(promo, branch)) {
    const err = new Error('Promo code is not available for selected barbershop');
    err.statusCode = 400;
    throw err;
  }

  return {
    promo: {
      code: promo.code,
      discount_type: promo.discount_type,
      discount_value: Number(promo.discount_value),
    },
    discountedTotal: applyPromoDiscount(total, promo),
  };
};

const validateCertificate = async ({ code, serviceIds, branch }) => {
  const normalizedCode = normalizeCode(code);
  if (!normalizedCode) {
    const err = new Error('certificate_code is required when payment_method is certificate');
    err.statusCode = 400;
    throw err;
  }

  let { data: certificate, error } = await repo.fetchCertificateByCode(normalizedCode);
  if (isMissingColumnError(error, 'marketplace_barbershop_id')) {
    ({ data: certificate, error } = await repo.fetchCertificateByCodeFallback(normalizedCode));
    if (certificate) certificate.marketplace_barbershop_id = null;
  }

  if (error) throw error;
  if (!certificate) {
    const err = new Error('Certificate not found');
    err.statusCode = 404;
    throw err;
  }

  if (certificate.is_used) {
    const err = new Error('Certificate is already used');
    err.statusCode = 400;
    throw err;
  }

  if (certificate.expires_at && new Date(certificate.expires_at) < new Date()) {
    const err = new Error('Your certificate is expired');
    err.statusCode = 400;
    throw err;
  }

  if (isScopedToDifferentBarbershop(certificate, branch)) {
    const err = new Error('Certificate is not available for selected barbershop');
    err.statusCode = 400;
    throw err;
  }

  if (Array.isArray(certificate.service_ids) && certificate.service_ids.length) {
    const allowed = new Set(certificate.service_ids.map(String));
    const hasCoveredService = serviceIds.some((serviceId) => allowed.has(String(serviceId)));
    if (!hasCoveredService) {
      const err = new Error('Selected services are not covered by this certificate');
      err.statusCode = 400;
      throw err;
    }
  }

  return certificate;
};

const parseTimeToHHMM = (value) => {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  // Postgres time columns often come as "HH:MM:SS"
  const m = text.match(/^(\d{2}:\d{2})(:\d{2})?$/);
  return m ? m[1] : null;
};

const extractWorkHoursForDay = ({ workHours, dayOfWeek }) => {
  if (!workHours) return null;

  let obj = workHours;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch (_err) {
      return null;
    }
  }

  if (!obj || typeof obj !== 'object') return null;

  const dayKeyCandidates = [
    String(dayOfWeek),
    ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dayOfWeek] || null,
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dayOfWeek] || null,
  ].filter(Boolean);

  const directStart = parseTimeToHHMM(obj.start_time || obj.start || obj.opens);
  const directEnd = parseTimeToHHMM(obj.end_time || obj.end || obj.closes);
  if (directStart && directEnd) return { start: directStart, end: directEnd };

  for (const key of dayKeyCandidates) {
    const day = obj[key];
    if (!day) continue;

    const start = parseTimeToHHMM(day.start_time || day.start || day.opens);
    const end = parseTimeToHHMM(day.end_time || day.end || day.closes);
    if (start && end) return { start, end };

    if (typeof day === 'string') {
      const m = String(day).trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (m) return { start: m[1], end: m[2] };
    }
  }

  return null;
};

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

const listCatalogBarbershops = async ({ active, city } = {}) => {
  const { data, error } = await repo.listMarketplaceBarbershops({ active, city });

  if (isMissingRelationError(error, 'marketplace_barbershops')) {
    return { items: [], count: 0, setup_required: true };
  }
  if (error) throw error;

  const { data: branches } = await repo.listAllBranchesMarketplaceLinks();
  const branchCounts = new Map();
  for (const branch of branches || []) {
    if (!branch?.marketplace_barbershop_id) continue;
    if (active !== null && active !== undefined && active === true && branch.is_active === false) continue;
    const key = String(branch.marketplace_barbershop_id);
    branchCounts.set(key, (branchCounts.get(key) || 0) + 1);
  }

  const items = (data || [])
    .filter(isRealMarketplaceBarbershop)
    .map((row) => formatBarbershop(row, branchCounts.get(String(row.id)) || 0));

  return { items, count: items.length };
};

const getCatalogBarbershop = async (id) => {
  const { data, error } = await repo.getMarketplaceBarbershopById(id);
  if (isMissingRelationError(error, 'marketplace_barbershops')) {
    const err = new Error('marketplace_barbershops table is not configured');
    err.statusCode = 501;
    throw err;
  }
  if (error) throw error;
  if (!data || !isRealMarketplaceBarbershop(data)) {
    const err = new Error('Barbershop not found');
    err.statusCode = 404;
    throw err;
  }
  return formatBarbershop(data);
};

const listCatalogBranches = async ({ barbershopId, active }) => {
  const { data, error } = await repo.listBranchesForBarbershop(barbershopId, { active });

  if (isMissingColumnError(error, 'marketplace_barbershop_id')) {
    return { items: [], count: 0, setup_required: true };
  }
  if (error) throw error;

  const items = (data || []).map((branch) => ({
    ...branch,
    marketplace_barbershop_id: branch.marketplace_barbershop_id || barbershopId,
  }));

  return { items, count: items.length };
};

const getBranchOrThrow = async (branchId) => {
  const { data: branch, error } = await repo.getBranch(branchId);
  if (error) throw error;
  if (!branch || branch.is_active === false) {
    const err = new Error('Branch not found');
    err.statusCode = 404;
    throw err;
  }
  return branch;
};

const getBranchDetails = async (branchId) => {
  const branch = await getBranchOrThrow(branchId);
  const [barbers, services] = await Promise.all([
    repo.getBranchOperationalBarbers(branchId),
    repo.getActiveServices(),
  ]);

  return {
    branch,
    barbers,
    services,
    categories: groupServicesByCategory(services),
  };
};

const listBranchBarbers = async (branchId) => {
  await getBranchOrThrow(branchId);
  const items = await repo.getBranchOperationalBarbers(branchId);
  return { items, count: items.length };
};

const listBranchServices = async (branchId) => {
  await getBranchOrThrow(branchId);
  const services = await repo.getActiveServices();
  return {
    items: services,
    categories: groupServicesByCategory(services),
    count: services.length,
  };
};

const getPaymentOptions = async (barbershopId) => {
  let { data: certificates, error } = await repo.listActiveCertificates();

  if (isMissingColumnError(error, 'marketplace_barbershop_id')) {
    ({ data: certificates, error } = await repo.listActiveCertificatesFallback());
    if (Array.isArray(certificates)) {
      certificates = certificates.map((row) => ({ ...row, marketplace_barbershop_id: null }));
    }
  }

  if (isMissingRelationError(error, 'certificates')) {
    return { payment_methods: PAYMENT_METHODS, certificates: [] };
  }

  if (error) throw error;

  const now = new Date();
  const scoped = (certificates || []).filter((certificate) => {
    if (certificate.expires_at && new Date(certificate.expires_at) < now) return false;
    return !certificate.marketplace_barbershop_id || certificate.marketplace_barbershop_id === barbershopId;
  });

  return { payment_methods: PAYMENT_METHODS, certificates: scoped };
};

const quoteBooking = async (payload) => {
  const branchId = normalizeId(payload?.branch_id);
  const barberId = normalizeId(payload?.barber_id);
  const serviceIds = Array.isArray(payload?.service_ids) && payload.service_ids.length
    ? payload.service_ids.map(normalizeId).filter(Boolean)
    : [normalizeId(payload?.service_id)].filter(Boolean);

  if (!branchId || !barberId || !serviceIds.length) {
    const err = new Error('branch_id, barber_id, and service_id/service_ids are required');
    err.statusCode = 400;
    throw err;
  }

  const branch = await getBranchOrThrow(branchId);

  const { data: barber, error: barberError } = await repo.fetchBarberById(barberId);
  if (barberError) throw barberError;
  if (!barber || barber.branch_id !== branchId || barber.is_active === false || barber.is_archived === true) {
    const err = new Error('Selected barber is not available for this branch');
    err.statusCode = 400;
    throw err;
  }

  const { data: barberUser, error: barberUserError } = await repo.fetchBarberUserRole(barberId);
  if (barberUserError) throw barberUserError;
  if (!barberUser) {
    const err = new Error('Selected employee is not available as a barber');
    err.statusCode = 400;
    throw err;
  }

  const { data: services, error: servicesError } = await repo.fetchServicesByIds(serviceIds);
  if (servicesError) throw servicesError;
  if (!services || services.length !== serviceIds.length) {
    const err = new Error('One or more service_ids are invalid');
    err.statusCode = 400;
    throw err;
  }
  if (services.some((service) => service.is_active === false)) {
    const err = new Error('One or more selected services are inactive');
    err.statusCode = 400;
    throw err;
  }

  const total = roundMoney(
    services.reduce((sum, service) => sum + Number(service.base_price || 0), 0)
  );

  const normalizedPaymentMethod = normalizeText(payload?.payment_method);
  if (normalizedPaymentMethod && !PAYMENT_METHODS.some((method) => method.value === normalizedPaymentMethod)) {
    const err = new Error('payment_method must be cash, card, or certificate');
    err.statusCode = 400;
    throw err;
  }

  const wantsCertificate = normalizedPaymentMethod === 'certificate' || Boolean(payload?.certificate_code);
  if (wantsCertificate && payload?.promo_code) {
    const err = new Error('Promo code cannot be used with certificate payment_method');
    err.statusCode = 400;
    throw err;
  }

  const { promo, discountedTotal } = await validatePromo({
    code: wantsCertificate ? null : payload?.promo_code,
    total,
    branch,
  });

  let certificate = null;
  let payableTotal = discountedTotal;
  if (wantsCertificate) {
    if (normalizedPaymentMethod && normalizedPaymentMethod !== 'certificate') {
      const err = new Error('certificate_code can only be used with certificate payment_method');
      err.statusCode = 400;
      throw err;
    }

    certificate = await validateCertificate({
      code: payload?.certificate_code,
      serviceIds,
      branch,
    });

    payableTotal = 0;
  }

  return {
    branch,
    barber,
    services,
    promo,
    certificate,
    payment_methods: PAYMENT_METHODS,
    totals: {
      total,
      discounted_total: discountedTotal,
      payable_total: payableTotal,
    },
  };
};

const ensureSameDay = ({ startsAt, branchTimezone }) => {
  if (!startsAt) return;
  const tz = branchTimezone || DEFAULT_TIMEZONE;
  const now = new Date();
  const todayLocal = getZonedDateString(now, tz);
  const startsLocal = getZonedDateString(startsAt, tz);
  if (todayLocal !== startsLocal) {
    const err = new Error('Only same-day booking is allowed');
    err.statusCode = 400;
    throw err;
  }
};

const listAvailability = async ({ branchId, barberId, serviceIds, date }) => {
  const branch = await getBranchOrThrow(branchId);
  const timezone = branch.timezone || DEFAULT_TIMEZONE;

  const now = new Date();
  const todayLocal = getZonedDateString(now, timezone);
  const requestedDate = normalizeText(date) || todayLocal;
  if (requestedDate !== todayLocal) {
    const err = new Error('Only same-day availability is supported');
    err.statusCode = 400;
    throw err;
  }

  const weekday = getZonedWeekdayIndex(now, timezone);
  if (weekday === null) {
    const err = new Error('Failed to determine weekday');
    err.statusCode = 500;
    throw err;
  }

  const cleanedServiceIds = Array.isArray(serviceIds) ? serviceIds.map(normalizeId).filter(Boolean) : [];

  const durationMinutes = cleanedServiceIds.length
    ? await (async () => {
      const { data: services, error } = await repo.fetchServicesByIds(cleanedServiceIds);
      if (error) throw error;
      const total = (services || []).reduce((sum, s) => sum + Number(s?.duration_minutes || 0), 0);
      return Math.max(1, Number.isFinite(total) ? total : 0);
    })()
    : 30;

  const { data: schedule, error: scheduleError } = await repo.fetchBranchScheduleForDay({
    branchId,
    dayOfWeek: weekday,
    barberId,
    localDate: requestedDate,
  });

  const workHoursFallback = extractWorkHoursForDay({ workHours: branch.work_hours, dayOfWeek: weekday });

  if (scheduleError && isMissingRelationError(scheduleError, 'barber_work_schedules')) {
    // No schedules table yet, use work_hours fallback only.
  } else if (scheduleError) {
    throw scheduleError;
  }

  const startHHMM = parseTimeToHHMM(schedule?.start_time) || workHoursFallback?.start || null;
  const endHHMM = parseTimeToHHMM(schedule?.end_time) || workHoursFallback?.end || null;
  if (!startHHMM || !endHHMM) {
    return {
      branch_id: branchId,
      barber_id: barberId,
      date: requestedDate,
      timezone,
      interval_minutes: SLOT_INTERVAL_MINUTES,
      duration_minutes: durationMinutes,
      schedule: null,
      items: [],
      count: 0,
      setup_required: Boolean(scheduleError && isMissingRelationError(scheduleError, 'barber_work_schedules')),
    };
  }

  const startParts = parseHHMM(startHHMM);
  const endParts = parseHHMM(endHHMM);
  if (!startParts || !endParts) {
    const err = new Error('Invalid work schedule time');
    err.statusCode = 500;
    throw err;
  }

  const nextDate = addDaysToDateString(requestedDate, 1);
  const dayStartUtc = zonedDateTimeToUtc({ dateStr: requestedDate, timeStr: '00:00', timeZone: timezone });
  const dayEndUtc = zonedDateTimeToUtc({ dateStr: nextDate, timeStr: '00:00', timeZone: timezone });

  const scheduleStartUtc = zonedDateTimeToUtc({ dateStr: requestedDate, timeStr: startHHMM, timeZone: timezone });
  let scheduleEndUtc = zonedDateTimeToUtc({ dateStr: requestedDate, timeStr: endHHMM, timeZone: timezone });
  if (scheduleStartUtc && scheduleEndUtc && scheduleEndUtc <= scheduleStartUtc) {
    scheduleEndUtc = zonedDateTimeToUtc({ dateStr: nextDate, timeStr: endHHMM, timeZone: timezone });
  }

  if (!dayStartUtc || !dayEndUtc || !scheduleStartUtc || !scheduleEndUtc) {
    const err = new Error('Failed to build availability window');
    err.statusCode = 500;
    throw err;
  }

  const { data: existing, error: existingError, setup_required } = await repo.fetchScheduledQueueEntriesForBarberDay({
    barberId,
    dayStartIso: dayStartUtc.toISOString(),
    dayEndIso: dayEndUtc.toISOString(),
  });
  if (existingError) throw existingError;

  const busyRanges = (existing || [])
    .filter((row) => row?.scheduled_start_at && row?.scheduled_end_at)
    .map((row) => ({
      start: new Date(row.scheduled_start_at),
      end: new Date(row.scheduled_end_at),
    }));

  const slots = [];
  const nowUtc = new Date();
  const start = new Date(Math.max(scheduleStartUtc.getTime(), nowUtc.getTime()));

  const msInterval = SLOT_INTERVAL_MINUTES * 60 * 1000;
  const roundedStart = new Date(Math.ceil(start.getTime() / msInterval) * msInterval);

  for (
    let cursor = new Date(roundedStart);
    cursor.getTime() + durationMinutes * 60 * 1000 <= scheduleEndUtc.getTime();
    cursor = new Date(cursor.getTime() + msInterval)
  ) {
    const end = new Date(cursor.getTime() + durationMinutes * 60 * 1000);
    const conflict = busyRanges.some((range) => overlaps(cursor, end, range.start, range.end));
    if (conflict) continue;

    slots.push({
      starts_at: cursor.toISOString(),
      ends_at: end.toISOString(),
    });
  }

  return {
    branch_id: branchId,
    barber_id: barberId,
    date: requestedDate,
    timezone,
    interval_minutes: SLOT_INTERVAL_MINUTES,
    duration_minutes: durationMinutes,
    schedule: { start_time: startHHMM, end_time: endHHMM },
    items: slots,
    count: slots.length,
    setup_required,
  };
};

module.exports = {
  listCatalogBarbershops,
  getCatalogBarbershop,
  listCatalogBranches,
  getBranchDetails,
  listBranchBarbers,
  listBranchServices,
  getPaymentOptions,
  quoteBooking,
  ensureSameDay,
  listAvailability,
};
