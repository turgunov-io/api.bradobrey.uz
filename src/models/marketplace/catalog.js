const { db } = require('../../config/postgres');
const kiosk = require('../kiosk');
const { applyPromoDiscount, roundMoney } = require('../../composable/cashback');

const DEFAULT_SERVICE_CATEGORY = 'Uncategorized';
const OPERATIONAL_BARBER_ROLES = ['barber', 'super-barber'];
const ACTIVE_QUEUE_STATUSES = ['waiting', 'called', 'swapped', 'in_progress'];
const PAYMENT_METHODS = [
  { value: 'cash', label: 'Наличные' },
  { value: 'card', label: 'Карта' },
  { value: 'certificate', label: 'Сертификат' },
];

const normalizeId = (value) => {
  const text = String(value || '').trim();
  return text || null;
};

const normalizeText = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
};

const normalizeCode = (value) => {
  const text = normalizeText(value);
  return text ? text.toUpperCase() : null;
};

const parseBoolean = (value, fallback = true) => {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
};

const isMissingRelationError = (error, relation) => {
  const message = String(error?.message || error?.details || '').toLowerCase();
  return Boolean(error) && message.includes(relation) && (
    message.includes('does not exist') ||
    message.includes('could not find') ||
    message.includes('schema cache')
  );
};

const isMissingColumnError = (error, column) => {
  const message = String(error?.message || error?.details || '').toLowerCase();
  return Boolean(error) && message.includes(column.toLowerCase()) && (
    message.includes('does not exist') ||
    message.includes('could not find') ||
    message.includes('schema cache')
  );
};

const groupServicesByCategory = (services = []) => {
  const grouped = new Map();

  for (const service of services) {
    const category = normalizeText(service?.category) || DEFAULT_SERVICE_CATEGORY;
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(service);
  }

  return Array.from(grouped.entries()).map(([category, items]) => ({
    category,
    services: items,
  }));
};

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

const formatBranchAsBarbershop = (row) => ({
  id: row.id,
  name: row.name,
  description: null,
  logo_url: null,
  cover_url: null,
  city: row.city || null,
  address: row.address || null,
  work_hours: row.work_hours || null,
  timezone: row.timezone || null,
  is_active: row.is_active !== false,
  sort_order: 0,
  branches_count: 1,
  metadata: { legacy_branch_id: row.id, fallback: true },
});

const getBranch = async (branchId) => {
  let { data, error } = await db
    .from('branches')
    .select('id, name, address, city, work_hours, timezone, is_active, marketplace_barbershop_id')
    .eq('id', branchId)
    .maybeSingle();

  if (isMissingColumnError(error, 'marketplace_barbershop_id')) {
    ({ data, error } = await db
      .from('branches')
      .select('id, name, address, city, work_hours, timezone, is_active')
      .eq('id', branchId)
      .maybeSingle());

    if (data) data.marketplace_barbershop_id = null;
  }

  return { data, error };
};

const getServices = async () => {
  const { data, error } = await db
    .from('services')
    .select('id, name, duration_minutes, base_price, category, is_active')
    .eq('is_active', true)
    .order('category', { ascending: true, nullsFirst: false })
    .order('base_price', { ascending: true })
    .order('name', { ascending: true });

  if (error) throw error;
  return data || [];
};

const getVisibleBarbers = async (branchId) => {
  const { data: barbers, error: barbersError } = await db
    .from('barbers')
    .select('id, name, branch_id, photo_url, specialization, is_on_shift, is_active')
    .eq('branch_id', branchId);

  if (barbersError) throw barbersError;

  const barberIds = (barbers || []).map((barber) => barber.id).filter(Boolean);
  if (!barberIds.length) return [];

  const { data: users, error: usersError } = await db
    .from('users')
    .select('id, role')
    .in('id', barberIds)
    .in('role', OPERATIONAL_BARBER_ROLES);

  if (usersError) throw usersError;

  const allowedBarberIds = new Set((users || []).map((user) => user.id));
  const visibleBarbers = (barbers || []).filter((barber) => (
    allowedBarberIds.has(barber.id) && barber.is_active !== false
  ));

  const { data: queues, error: queueError } = await db
    .from('queue_entries')
    .select('id, barber_id, service_id, service_ids, status')
    .eq('branch_id', branchId)
    .in('status', ACTIVE_QUEUE_STATUSES);

  if (queueError) throw queueError;

  const activeQueues = (queues || []).filter((entry) => allowedBarberIds.has(entry.barber_id));
  const serviceIds = Array.from(new Set(
    activeQueues.flatMap((entry) => (
      Array.isArray(entry.service_ids) && entry.service_ids.length
        ? entry.service_ids
        : [entry.service_id]
    )).filter(Boolean)
  ));

  let serviceDurationById = new Map();
  if (serviceIds.length) {
    const { data: services, error: servicesError } = await db
      .from('services')
      .select('id, duration_minutes')
      .in('id', serviceIds);

    if (servicesError) throw servicesError;
    serviceDurationById = new Map((services || []).map((service) => [
      String(service.id),
      Number(service.duration_minutes || 0),
    ]));
  }

  const waitingByBarber = new Map();
  const queueCountByBarber = new Map();

  for (const entry of activeQueues) {
    const key = String(entry.barber_id);
    const entryServiceIds = Array.isArray(entry.service_ids) && entry.service_ids.length
      ? entry.service_ids
      : [entry.service_id];
    const duration = entryServiceIds.reduce((sum, serviceId) => (
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

const validatePromo = async ({ code, total, branch }) => {
  const normalizedCode = normalizeCode(code);
  if (!normalizedCode) return { promo: null, discountedTotal: total };

  const { data: promo, error } = await db
    .from('promo_codes')
    .select('*')
    .eq('code', normalizedCode)
    .maybeSingle();

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
  if (!promo.is_unlimited && Number(promo.used_count || 0) >= Number(promo.usage_limit || 0)) {
    const err = new Error('Promo code expired or limit reached');
    err.statusCode = 400;
    throw err;
  }
  if (promo.marketplace_barbershop_id && promo.marketplace_barbershop_id !== branch.marketplace_barbershop_id) {
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

const fetchCertificateByCode = async (code) => {
  let { data, error } = await db
    .from('certificates')
    .select('id, code, service_ids, expires_at, is_used, metadata, marketplace_barbershop_id')
    .eq('code', code)
    .maybeSingle();

  if (isMissingColumnError(error, 'marketplace_barbershop_id')) {
    ({ data, error } = await db
      .from('certificates')
      .select('id, code, service_ids, expires_at, is_used, metadata')
      .eq('code', code)
      .maybeSingle());

    if (data) data.marketplace_barbershop_id = null;
  }

  return { data, error };
};

const validateCertificate = async ({ code, serviceIds, branch }) => {
  const normalizedCode = normalizeText(code);
  if (!normalizedCode) {
    const err = new Error('certificate_code is required when payment_method is certificate');
    err.statusCode = 400;
    throw err;
  }

  const { data: certificate, error } = await fetchCertificateByCode(normalizedCode);
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
  if (certificate.marketplace_barbershop_id && certificate.marketplace_barbershop_id !== branch.marketplace_barbershop_id) {
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

class MarketplaceCatalog {
  async listBarbershops(req, res) {
    try {
      const active = parseBoolean(req.query?.active, true);

      let query = db
        .from('marketplace_barbershops')
        .select('id, name, description, logo_url, cover_url, city, address, work_hours, timezone, is_active, sort_order, metadata');

      if (active !== null) query = query.eq('is_active', active);

      const { data, error } = await query
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });

      if (isMissingRelationError(error, 'marketplace_barbershops')) {
        return this.listBranchFallbackBarbershops(req, res);
      }
      if (error) return res.status(500).json({ error: error.message });

      if (!data || !data.length) {
        return this.listBranchFallbackBarbershops(req, res);
      }

      const { data: branches } = await db
        .from('branches')
        .select('id, marketplace_barbershop_id, is_active');

      const branchCounts = new Map();
      for (const branch of branches || []) {
        if (!branch?.marketplace_barbershop_id) continue;
        if (active !== null && branch.is_active === false && active === true) continue;
        const key = String(branch.marketplace_barbershop_id);
        branchCounts.set(key, (branchCounts.get(key) || 0) + 1);
      }

      const items = (data || []).map((row) => formatBarbershop(row, branchCounts.get(String(row.id)) || 0));
      return res.json({ items, count: items.length });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async listBranchFallbackBarbershops(req, res) {
    const active = parseBoolean(req.query?.active, true);
    let query = db
      .from('branches')
      .select('id, name, address, city, work_hours, timezone, is_active');

    if (active !== null) query = query.eq('is_active', active);

    const { data, error } = await query.order('name', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const items = (data || []).map(formatBranchAsBarbershop);
    return res.json({ items, count: items.length, fallback: true });
  }

  async getBarbershop(req, res) {
    try {
      const id = normalizeId(req.params?.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data, error } = await db
        .from('marketplace_barbershops')
        .select('id, name, description, logo_url, cover_url, city, address, work_hours, timezone, is_active, sort_order, metadata')
        .eq('id', id)
        .maybeSingle();

      if (isMissingRelationError(error, 'marketplace_barbershops')) {
        const branch = await getBranch(id);
        if (branch.error) return res.status(500).json({ error: branch.error.message });
        if (!branch.data) return res.status(404).json({ error: 'Barbershop not found' });
        return res.json({ item: formatBranchAsBarbershop(branch.data), fallback: true });
      }
      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Barbershop not found' });

      return res.json({ item: formatBarbershop(data) });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async listBranches(req, res) {
    try {
      const id = normalizeId(req.params?.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const active = parseBoolean(req.query?.active, true);
      let query = db
        .from('branches')
        .select('id, name, address, city, work_hours, timezone, is_active, marketplace_barbershop_id')
        .eq('marketplace_barbershop_id', id);

      if (active !== null) query = query.eq('is_active', active);

      let { data, error } = await query.order('name', { ascending: true });

      if (isMissingColumnError(error, 'marketplace_barbershop_id') || (!error && (!data || !data.length))) {
        let fallbackQuery = db
          .from('branches')
          .select('id, name, address, city, work_hours, timezone, is_active')
          .eq('id', id);

        if (active !== null) fallbackQuery = fallbackQuery.eq('is_active', active);

        ({ data, error } = await fallbackQuery.order('name', { ascending: true }));
      }

      if (error) return res.status(500).json({ error: error.message });

      const items = (data || []).map((branch) => ({
        ...branch,
        marketplace_barbershop_id: branch.marketplace_barbershop_id || id,
      }));

      return res.json({ items, count: items.length });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async branchDetails(req, res) {
    try {
      const id = normalizeId(req.params?.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data: branch, error } = await getBranch(id);
      if (error) return res.status(500).json({ error: error.message });
      if (!branch || branch.is_active === false) return res.status(404).json({ error: 'Branch not found' });

      const [barbers, services] = await Promise.all([
        getVisibleBarbers(id),
        getServices(),
      ]);

      return res.json({
        branch,
        barbers,
        services,
        categories: groupServicesByCategory(services),
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async branchBarbers(req, res) {
    try {
      const id = normalizeId(req.params?.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data: branch, error } = await getBranch(id);
      if (error) return res.status(500).json({ error: error.message });
      if (!branch || branch.is_active === false) return res.status(404).json({ error: 'Branch not found' });

      const items = await getVisibleBarbers(id);
      return res.json({ items, count: items.length });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async branchServices(req, res) {
    try {
      const id = normalizeId(req.params?.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data: branch, error } = await getBranch(id);
      if (error) return res.status(500).json({ error: error.message });
      if (!branch || branch.is_active === false) return res.status(404).json({ error: 'Branch not found' });

      const services = await getServices();
      return res.json({
        items: services,
        categories: groupServicesByCategory(services),
        count: services.length,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async paymentOptions(req, res) {
    try {
      const id = normalizeId(req.params?.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      let { data: certificates, error } = await db
        .from('certificates')
        .select('id, code, service_ids, expires_at, is_used, metadata, marketplace_barbershop_id')
        .eq('is_used', false)
        .order('code', { ascending: true });

      if (isMissingColumnError(error, 'marketplace_barbershop_id')) {
        ({ data: certificates, error } = await db
          .from('certificates')
          .select('id, code, service_ids, expires_at, is_used, metadata')
          .eq('is_used', false)
          .order('code', { ascending: true }));
      }

      if (isMissingRelationError(error, 'certificates')) {
        return res.json({
          payment_methods: PAYMENT_METHODS,
          certificates: [],
        });
      }

      if (error) return res.status(500).json({ error: error.message });

      const now = new Date();
      const scopedCertificates = (certificates || []).filter((certificate) => {
        if (certificate.expires_at && new Date(certificate.expires_at) < now) return false;
        return !certificate.marketplace_barbershop_id || certificate.marketplace_barbershop_id === id;
      });

      return res.json({
        payment_methods: PAYMENT_METHODS,
        certificates: scopedCertificates,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async quote(req, res) {
    try {
      const {
        branch_id,
        barber_id,
        service_id,
        service_ids,
        payment_method = null,
        promo_code = null,
        certificate_code = null,
      } = req.body || {};

      const branchId = normalizeId(branch_id);
      const barberId = normalizeId(barber_id);
      const serviceIds = Array.isArray(service_ids) && service_ids.length
        ? service_ids.map(normalizeId).filter(Boolean)
        : [normalizeId(service_id)].filter(Boolean);

      if (!branchId || !barberId || !serviceIds.length) {
        return res.status(400).json({ error: 'branch_id, barber_id, and service_id/service_ids are required' });
      }

      const { data: branch, error: branchError } = await getBranch(branchId);
      if (branchError) return res.status(500).json({ error: branchError.message });
      if (!branch || branch.is_active === false) return res.status(404).json({ error: 'Branch not found' });

      const { data: barber, error: barberError } = await db
        .from('barbers')
        .select('id, name, branch_id, is_active, is_on_shift')
        .eq('id', barberId)
        .maybeSingle();

      if (barberError) return res.status(500).json({ error: barberError.message });
      if (!barber || barber.branch_id !== branchId || barber.is_active === false) {
        return res.status(400).json({ error: 'Selected barber is not available for this branch' });
      }

      const { data: barberUser, error: barberUserError } = await db
        .from('users')
        .select('id, role')
        .eq('id', barberId)
        .in('role', OPERATIONAL_BARBER_ROLES)
        .maybeSingle();

      if (barberUserError) return res.status(500).json({ error: barberUserError.message });
      if (!barberUser) return res.status(400).json({ error: 'Selected employee is not available as a barber' });

      const { data: services, error: servicesError } = await db
        .from('services')
        .select('id, name, duration_minutes, base_price, category, is_active')
        .in('id', serviceIds);

      if (servicesError) return res.status(500).json({ error: servicesError.message });
      if (!services || services.length !== serviceIds.length) {
        return res.status(400).json({ error: 'One or more service_ids are invalid' });
      }
      if (services.some((service) => service.is_active === false)) {
        return res.status(400).json({ error: 'One or more selected services are inactive' });
      }

      const total = roundMoney(services.reduce((sum, service) => (
        sum + Number(service.base_price || 0)
      ), 0));

      const normalizedPaymentMethod = normalizeText(payment_method);
      if (normalizedPaymentMethod && !PAYMENT_METHODS.some((method) => method.value === normalizedPaymentMethod)) {
        return res.status(400).json({ error: 'payment_method must be cash, card, or certificate' });
      }

      const wantsCertificate = normalizedPaymentMethod === 'certificate' || Boolean(certificate_code);

      if (wantsCertificate && promo_code) {
        return res.status(400).json({ error: 'Promo code cannot be used with certificate payment_method' });
      }

      const { promo, discountedTotal } = await validatePromo({
        code: wantsCertificate ? null : promo_code,
        total,
        branch,
      });

      let certificate = null;
      let payableTotal = discountedTotal;
      if (wantsCertificate) {
        if (normalizedPaymentMethod && normalizedPaymentMethod !== 'certificate') {
          return res.status(400).json({ error: 'certificate_code can only be used with certificate payment_method' });
        }

        certificate = await validateCertificate({
          code: certificate_code,
          serviceIds,
          branch,
        });
        payableTotal = 0;
      }

      return res.json({
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
      });
    } catch (error) {
      console.error(error);
      return res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error' });
    }
  }

  async createBooking(req, res) {
    const body = { ...(req.body || {}) };
    if (body.certificate_code && !body.payment_method) {
      body.payment_method = 'certificate';
    }

    req.body = {
      ...body,
      source: 'site',
    };

    return kiosk.book(req, res);
  }
}

module.exports = new MarketplaceCatalog();
