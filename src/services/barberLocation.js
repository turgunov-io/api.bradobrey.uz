const { verifyAny } = require('../utils/authToken');
const { checkTenantAccess } = require('../utils/tenant');
const { db } = require('../config/postgres');

const LOCATION_ROLES = new Set(['barber', 'super-barber']);
const ADMIN_ROLES = new Set(['admin', 'admin_network', 'super-manager', 'manager', 'admin_branch']);
const BRANCH_SCOPED_ADMIN_ROLES = new Set(['manager', 'admin_branch']);
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

const isLocationControlEnabled = (config) => Boolean(config && config.is_enabled === true);

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
  const config = await loadLocation(branchId);
  if (!isLocationControlEnabled(config)) {
    return { ok: true, geolocationSkipped: true, config, event: null };
  }

  if (!location) {
    return { ok: false, statusCode: 403, code: 'LOCATION_REQUIRED', event: null };
  }

  const normalized = normalizeLocation(location);
  if (normalized.error) {
    const event = await insertEvent({ barberId, branchId, ...normalized.value || {}, status: 'rejected', reason: normalized.error });
    return { ok: false, statusCode: 403, code: normalized.error, event };
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

const LOCATION_ACTOR_SQL = `select u.id, u.role, u.branch_id, u.company_id, c.status as company_status
     from users u
     left join companies c on c.id = u.company_id
    where u.id = $1
    limit 1`;

// Phase 2 LOW: the branch of a branch-scoped administrator comes from the DB
// (users.branch_id). Only for the session-bound manager role is it the session
// branch, and only when middleware/employeeAccess validated that session for
// this very account; the bare token claim is never trusted.
const SESSION_BRANCH_ROLES = new Set(['manager', 'super-manager']);
function resolveActorBranchId({ req, payload, user, role }) {
  if (SESSION_BRANCH_ROLES.has(role)) {
    const access = req?.employeeAccess;
    const validated = access?.sessionValid === true && String(access?.user?.id || '') === String(user.id);
    return validated ? (String(payload?.branchId || '').trim() || null) : null;
  }
  return String(user.branch_id || '').trim() || null;
}

// MULTI_TENANCY B2: role and company come from the database (never the
// token). Returns { role, branchId (session branch), companyId } or null after
// an error response. Branch-scoped roles stay pinned to their session branch.
async function authenticateLocationUser(req, res) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Authorization token is required' }); return null; }
  let payload;
  try { payload = verifyAny(token); } catch (_error) { res.status(401).json({ error: 'Invalid or expired token' }); return null; }
  const userId = payload?.sub || payload?.id;
  if (!userId) { res.status(401).json({ error: 'Invalid token payload' }); return null; }

  let user;
  try {
    const result = await db.query(LOCATION_ACTOR_SQL, [userId]);
    user = result.rows?.[0] || null;
  } catch (_error) {
    res.status(500).json({ error: 'Failed to authorize request' });
    return null;
  }
  if (!user) { res.status(401).json({ error: 'Session is no longer valid' }); return null; }
  const tenantCheck = checkTenantAccess({ payload, user });
  if (!tenantCheck.ok) { res.status(tenantCheck.status).json(tenantCheck.body); return null; }
  const role = String(user.role || '').trim().toLowerCase();
  if (!ADMIN_ROLES.has(role)) { res.status(403).json({ error: 'Location administration is not allowed' }); return null; }
  return {
    role,
    branchId: resolveActorBranchId({ req, payload, user, role }),
    companyId: tenantCheck.tenant.companyId,
  };
}

const branchInCompany = async (branchId, companyId) => {
  if (!branchId || !companyId) return false;
  const result = await db.query('select 1 from branches where id = $1 and company_id = $2 limit 1', [branchId, companyId]);
  return Boolean(result.rows?.[0]);
};

const outsideScope = (res) => res.status(403).json({ error: 'Branch scope does not allow this operation' });

async function saveBranchLocation(req, res) {
  const payload = await authenticateLocationUser(req, res); if (!payload) return;
  const branchId = String(req.params.id || '').trim();
  const body = req.body || {};
  const latitude = numberInRange(body.latitude, -90, 90);
  const longitude = numberInRange(body.longitude, -180, 180);
  const radiusMeters = numberInRange(body.radius_meters ?? body.radius, 1, 50000);
  if (latitude === null || longitude === null || radiusMeters === null) return res.status(400).json({ error: 'Coordinates and radius are invalid' });
  if (BRANCH_SCOPED_ADMIN_ROLES.has(payload.role) && String(payload.branchId || '') !== branchId) return outsideScope(res);
  if (!(await branchInCompany(branchId, payload.companyId))) return outsideScope(res);
  const result = await db.query(`
    insert into branch_locations (branch_id, latitude, longitude, radius_meters, is_enabled, updated_at, company_id)
    values ($1,$2,$3,$4,$5,now(),$6)
    on conflict (branch_id) do update set latitude=excluded.latitude, longitude=excluded.longitude,
      radius_meters=excluded.radius_meters, is_enabled=excluded.is_enabled, updated_at=now()
    returning id, branch_id, latitude, longitude, radius_meters, is_enabled, updated_at
  `, [branchId, latitude, longitude, radiusMeters, body.is_enabled !== false, payload.companyId]);
  return res.json({ location: result.rows[0] });
}

async function getBranchLocation(req, res) {
  const payload = await authenticateLocationUser(req, res); if (!payload) return;
  if (BRANCH_SCOPED_ADMIN_ROLES.has(payload.role) && String(payload.branchId || '') !== String(req.params.id || '')) return outsideScope(res);
  if (!(await branchInCompany(String(req.params.id || '').trim(), payload.companyId))) return outsideScope(res);
  const location = await loadLocation(req.params.id);
  return res.json({ location });
}

async function listLocationEvents(req, res) {
  const payload = await authenticateLocationUser(req, res); if (!payload) return;
  let branchId = String(req.query.branch_id || '').trim();
  const eventId = String(req.query.event_id || '').trim();
  if (BRANCH_SCOPED_ADMIN_ROLES.has(payload.role)) {
    const allowedBranchId = String(payload.branchId || '').trim();
    if (!allowedBranchId || (branchId && allowedBranchId !== branchId)) return res.status(403).json({ error: 'Branch scope does not allow this operation' });
    branchId = allowedBranchId;
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  // Company first: network roles see their whole company, never another's.
  const params = [payload.companyId];
  const conditions = ['e.company_id = $1'];
  if (branchId) { params.push(branchId); conditions.push(`e.branch_id = $${params.length}`); }
  if (eventId) { params.push(eventId); conditions.push(`e.id = $${params.length}`); }
  params.push(limit);
  const result = await db.query(`
    select e.id, e.barber_id, e.branch_id, e.latitude, e.longitude,
      e.branch_latitude, e.branch_longitude, e.distance_meters, e.accuracy_meters,
      e.measured_at, e.status, e.reason, e.created_at, b.name as barber_name, br.name as branch_name
    from barber_login_location_events e
    left join barbers b on b.id = e.barber_id
    left join branches br on br.id = e.branch_id
    where ${conditions.join(' and ')} order by e.created_at desc limit $${params.length}
  `, params);
  return res.json({ items: result.rows || [] });
}

module.exports = {
  LOCATION_ROLES,
  isLocationControlEnabled,
  loadLocation,
  normalizeLocation,
  haversineMeters,
  verifyAndRecordLoginLocation,
  getBranchLocation,
  saveBranchLocation,
  listLocationEvents,
};
