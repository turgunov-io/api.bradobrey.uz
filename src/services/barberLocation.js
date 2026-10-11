const jwt = require('jsonwebtoken');
const { db } = require('../config/postgres');

const LOCATION_ROLES = new Set(['barber', 'super-barber']);
const ADMIN_ROLES = new Set(['admin', 'admin_network', 'super-manager', 'manager', 'admin_branch']);
const DEFAULT_RADIUS_METERS = 1000;
const MAX_ACCURACY_METERS = 200;
const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_MS = 2 * 60 * 1000;

const haversineMeters = (latitude, longitude, targetLatitude, targetLongitude) => {
  const radians = (value) => (value * Math.PI) / 180;
  const earthRadius = 6371008.8;
  const dLat = radians(targetLatitude - latitude);
  const dLon = radians(targetLongitude - longitude);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(latitude)) * Math.cos(radians(targetLatitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(a));
};

const numberInRange = (value, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
};

const normalizeLocation = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  const latitude = numberInRange(source.latitude, -90, 90);
  const longitude = numberInRange(source.longitude, -180, 180);
  const accuracy = numberInRange(source.accuracy_meters ?? source.accuracy, 0.1, 10000);
  const measuredAt = source.measured_at ?? source.timestamp;
  const timestamp = measuredAt ? Date.parse(measuredAt) : NaN;
  const clientEventId = String(source.client_event_id || source.request_id || '').trim().slice(0, 120) || null;

  if (latitude === null || longitude === null) return { error: 'INVALID_COORDINATES' };
  if (accuracy === null || accuracy > MAX_ACCURACY_METERS) return { error: 'LOW_ACCURACY' };
  if (!Number.isFinite(timestamp) || timestamp < Date.now() - MAX_AGE_MS || timestamp > Date.now() + MAX_FUTURE_MS) {
    return { error: 'STALE_COORDINATES' };
  }
  if (source.is_mocked === true || source.mocked === true) return { error: 'MOCKED_COORDINATES' };

  return { value: { latitude, longitude, accuracy, measuredAt: new Date(timestamp), clientEventId } };
};

const loadLocation = async (branchId) => {
  const { data, error } = await db.from('branch_locations')
    .select('id, branch_id, latitude, longitude, radius_meters, is_enabled, updated_at')
    .eq('branch_id', branchId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

const insertEvent = async (event) => {
  const result = await db.query(`
    insert into barber_login_location_events
      (client_event_id, barber_id, branch_id, latitude, longitude, branch_latitude,
       branch_longitude, distance_meters, accuracy_meters, measured_at, status, reason)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    on conflict (barber_id, client_event_id) where client_event_id is not null
    do update set created_at = barber_login_location_events.created_at
    returning *
  `, [event.clientEventId, event.barberId, event.branchId, event.latitude, event.longitude,
    event.branchLatitude, event.branchLongitude, event.distanceMeters, event.accuracy,
    event.measuredAt, event.status, event.reason]);
  return result.rows?.[0] || null;
};

async function verifyAndRecordLoginLocation({ barberId, branchId, location }) {
  const normalized = normalizeLocation(location);
  if (normalized.error) {
    const event = await insertEvent({ barberId, branchId, ...normalized.value || {}, status: 'rejected', reason: normalized.error });
    return { ok: false, statusCode: 403, code: normalized.error, event };
  }

  const config = await loadLocation(branchId);
  if (!config || config.is_enabled !== true) {
    const event = await insertEvent({ ...normalized.value, barberId, branchId, status: 'rejected', reason: 'LOCATION_NOT_CONFIGURED' });
    return { ok: false, statusCode: 403, code: 'LOCATION_NOT_CONFIGURED', event };
  }

  const distanceMeters = haversineMeters(normalized.value.latitude, normalized.value.longitude, config.latitude, config.longitude);
  const inside = distanceMeters <= Number(config.radius_meters || DEFAULT_RADIUS_METERS);
  const event = await insertEvent({
    ...normalized.value,
    barberId,
    branchId,
    branchLatitude: config.latitude,
    branchLongitude: config.longitude,
    distanceMeters,
    status: inside ? 'inside_radius' : 'outside_radius',
    reason: inside ? null : 'OUTSIDE_ALLOWED_RADIUS',
  });
  return { ok: true, outsideRadius: !inside, distanceMeters, event, config };
}

function authenticateLocationUser(req, res) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Authorization token is required' }); return null; }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!ADMIN_ROLES.has(payload?.role)) { res.status(403).json({ error: 'Location administration is not allowed' }); return null; }
    return payload;
  } catch (_error) { res.status(401).json({ error: 'Invalid or expired token' }); return null; }
}

async function saveBranchLocation(req, res) {
  const payload = authenticateLocationUser(req, res); if (!payload) return;
  const branchId = String(req.params.id || '').trim();
  const body = req.body || {};
  const latitude = numberInRange(body.latitude, -90, 90);
  const longitude = numberInRange(body.longitude, -180, 180);
  const radiusMeters = numberInRange(body.radius_meters ?? body.radius, 1, 50000);
  if (latitude === null || longitude === null || radiusMeters === null) return res.status(400).json({ error: 'Coordinates and radius are invalid' });
  if (payload.role === 'manager' && String(payload.branchId || '') !== branchId) return res.status(403).json({ error: 'Branch scope does not allow this operation' });
  const result = await db.query(`
    insert into branch_locations (branch_id, latitude, longitude, radius_meters, is_enabled, updated_at)
    values ($1,$2,$3,$4,$5,now())
    on conflict (branch_id) do update set latitude=excluded.latitude, longitude=excluded.longitude,
      radius_meters=excluded.radius_meters, is_enabled=excluded.is_enabled, updated_at=now()
    returning id, branch_id, latitude, longitude, radius_meters, is_enabled, updated_at
  `, [branchId, latitude, longitude, radiusMeters, body.is_enabled !== false]);
  return res.json({ location: result.rows[0] });
}

async function getBranchLocation(req, res) {
  const payload = authenticateLocationUser(req, res); if (!payload) return;
  if (payload.role === 'manager' && String(payload.branchId || '') !== String(req.params.id || '')) return res.status(403).json({ error: 'Branch scope does not allow this operation' });
  const location = await loadLocation(req.params.id);
  return res.json({ location });
}

async function listLocationEvents(req, res) {
  const payload = authenticateLocationUser(req, res); if (!payload) return;
  const branchId = String(req.query.branch_id || '').trim();
  if (payload.role === 'manager' && branchId && String(payload.branchId || '') !== branchId) return res.status(403).json({ error: 'Branch scope does not allow this operation' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const params = [];
  let where = '';
  if (branchId) { params.push(branchId); where = 'where e.branch_id = $1'; }
  params.push(limit);
  const result = await db.query(`
    select e.id, e.barber_id, e.branch_id, e.distance_meters, e.accuracy_meters,
      e.measured_at, e.status, e.reason, e.created_at, b.name as barber_name, br.name as branch_name
    from barber_login_location_events e
    left join barbers b on b.id = e.barber_id
    left join branches br on br.id = e.branch_id
    ${where} order by e.created_at desc limit $${params.length}
  `, params);
  return res.json({ items: result.rows || [] });
}

module.exports = {
  LOCATION_ROLES,
  normalizeLocation,
  haversineMeters,
  verifyAndRecordLoginLocation,
  getBranchLocation,
  saveBranchLocation,
  listLocationEvents,
};
