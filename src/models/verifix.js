const jwt = require('jsonwebtoken');
const { db } = require('../config/postgres');

const ADMIN_ROLES = new Set(['admin_network', 'admin_branch', 'admin', 'merchant']);
const BARBER_ROLES = new Set(['barber', 'super-barber']);
const DEFAULT_TIMEZONE = 'Asia/Tashkent';
const EVENT_TYPES = new Set([
  'login',
  'logout',
  'shift_start',
  'shift_end',
  'break_start',
  'break_end',
  'manual_adjustment',
]);
const LATE_EVENT_TYPES = new Set(['login', 'shift_start']);
const SOURCES = new Set(['barber_kiosk', 'dashboard', 'system']);

const getBearerToken = (req) => {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
};

const verifyJwt = (token) => jwt.verify(token, process.env.JWT_SECRET);

const normalizeText = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text || null;
};

const normalizeId = (value) => {
  const text = normalizeText(value);
  return text || null;
};

const parseBoolean = (value, fallback = undefined) => {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseNonNegativeNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

const parseNonNegativeInteger = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
};

const normalizeEventType = (value) => {
  const eventType = normalizeText(value);
  return eventType && EVENT_TYPES.has(eventType) ? eventType : null;
};

const normalizeSource = (value, fallback) => {
  const source = normalizeText(value) || fallback;
  return SOURCES.has(source) ? source : fallback;
};

const normalizeTime = (value) => {
  const text = normalizeText(value);
  if (!text) return null;

  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
  if (!match) return null;

  return `${match[1]}:${match[2]}:${match[3] || '00'}`;
};

const normalizeDate = (value) => {
  const text = normalizeText(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};

const normalizeDateTime = (value, fallback = new Date()) => {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getFormatter = (timeZone) => new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: '2-digit',
  second: '2-digit',
  timeZone,
  year: 'numeric',
});

const normalizeTimeZone = (value) => {
  const timeZone = normalizeText(value) || DEFAULT_TIMEZONE;

  try {
    getFormatter(timeZone).format(new Date());
    return timeZone;
  } catch (_error) {
    return DEFAULT_TIMEZONE;
  }
};

const getTimeZoneParts = (date, timeZone) => {
  const parts = getFormatter(timeZone).formatToParts(date);
  const values = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = Number(part.value);
    }
  }

  return values;
};

const getTimeZoneOffsetMs = (date, timeZone) => {
  const parts = getTimeZoneParts(date, timeZone);
  const utcTime = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return utcTime - date.getTime();
};

const zonedDateTimeToUtc = ({ day, hour = 0, minute = 0, month, second = 0, year }, timeZone) => {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);

  return new Date(utcGuess - offset);
};

const parseTimeParts = (time) => {
  const [hour, minute, second] = String(time || '00:00:00').split(':').map((part) => Number(part));
  return {
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
    second: Number.isFinite(second) ? second : 0,
  };
};

const localDateKey = (parts) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
};

const dayOfWeekFromLocalParts = (parts) => {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
};

const requireAuth = (req, res) => {
  const token = getBearerToken(req);

  if (!token) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }

  try {
    const payload = verifyJwt(token);
    return {
      id: payload.sub || payload.id,
      login: payload.login || null,
      role: payload.role || null,
      branchId: payload.branchId || payload.branch_id || null,
    };
  } catch (_error) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
};

const requireAdmin = (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return null;

  if (!ADMIN_ROLES.has(auth.role)) {
    res.status(403).json({ error: 'Only admins can manage Verifix schedules' });
    return null;
  }

  return auth;
};

const getBranch = async (branchId) => {
  if (!branchId) return null;

  const { data, error } = await db
    .from('branches')
    .select('id, name, timezone')
    .eq('id', branchId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
};

const getBarber = async (barberId) => {
  if (!barberId) return null;

  const { data, error } = await db
    .from('barbers')
    .select('id, name, branch_id')
    .eq('id', barberId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
};

const findSchedule = async ({ barberId, branchId, occurredAt, timeZone }) => {
  if (!branchId || !occurredAt) return null;

  const localParts = getTimeZoneParts(occurredAt, timeZone);
  const dayOfWeek = dayOfWeekFromLocalParts(localParts);
  const dateKey = localDateKey(localParts);

  const { data, error } = await db
    .from('barber_work_schedules')
    .select('id, branch_id, barber_id, day_of_week, start_time, end_time, grace_minutes, is_active, valid_from, valid_to')
    .eq('branch_id', branchId)
    .eq('day_of_week', dayOfWeek)
    .eq('is_active', true);

  if (error) throw new Error(error.message);

  const schedules = (data || [])
    .filter((schedule) => !schedule.barber_id || schedule.barber_id === barberId)
    .filter((schedule) => !schedule.valid_from || schedule.valid_from <= dateKey)
    .filter((schedule) => !schedule.valid_to || schedule.valid_to >= dateKey)
    .sort((left, right) => {
      if (left.barber_id === barberId && right.barber_id !== barberId) return -1;
      if (left.barber_id !== barberId && right.barber_id === barberId) return 1;
      return String(left.start_time || '').localeCompare(String(right.start_time || ''));
    });

  return schedules[0] || null;
};

const calculateLateState = ({ eventType, occurredAt, schedule, timeZone }) => {
  if (!LATE_EVENT_TYPES.has(eventType) || !schedule?.start_time) {
    return {
      grace_minutes: Number(schedule?.grace_minutes || 0),
      is_late: false,
      late_by_minutes: 0,
      schedule_id: schedule?.id || null,
      scheduled_start_at: null,
    };
  }

  const localParts = getTimeZoneParts(occurredAt, timeZone);
  const startParts = parseTimeParts(schedule.start_time);
  const scheduledStart = zonedDateTimeToUtc({
    day: localParts.day,
    hour: startParts.hour,
    minute: startParts.minute,
    month: localParts.month,
    second: startParts.second,
    year: localParts.year,
  }, timeZone);
  const graceMinutes = parseNonNegativeInteger(schedule.grace_minutes, 0);
  const lateByMinutes = Math.max(
    0,
    Math.floor((occurredAt.getTime() - scheduledStart.getTime()) / 60000) - graceMinutes,
  );

  return {
    grace_minutes: graceMinutes,
    is_late: lateByMinutes > 0,
    late_by_minutes: lateByMinutes,
    schedule_id: schedule.id,
    scheduled_start_at: scheduledStart.toISOString(),
  };
};

async function recordActivityEvent({
  actorId = null,
  actorRole = null,
  barberId,
  branchId = null,
  eventType,
  io = null,
  metadata = {},
  occurredAt = new Date(),
  penaltyAmount = 0,
  penaltyReason = null,
  source = 'barber_kiosk',
} = {}) {
  const normalizedEventType = normalizeEventType(eventType);
  if (!normalizedEventType) {
    throw new Error('Invalid event_type');
  }

  const actualOccurredAt = occurredAt instanceof Date ? occurredAt : normalizeDateTime(occurredAt);
  if (!actualOccurredAt) {
    throw new Error('occurred_at must be a valid date/time');
  }

  const barber = await getBarber(barberId);
  if (!barber) {
    throw new Error('Barber not found');
  }

  const finalBranchId = branchId || barber.branch_id;
  const branch = await getBranch(finalBranchId);
  if (!branch) {
    throw new Error('Branch not found');
  }

  if (barber.branch_id && finalBranchId && barber.branch_id !== finalBranchId) {
    throw new Error('Barber does not belong to this branch');
  }

  const timeZone = normalizeTimeZone(branch.timezone);
  const schedule = await findSchedule({
    barberId: barber.id,
    branchId: finalBranchId,
    occurredAt: actualOccurredAt,
    timeZone,
  });
  const lateState = calculateLateState({
    eventType: normalizedEventType,
    occurredAt: actualOccurredAt,
    schedule,
    timeZone,
  });
  const eventMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : {};

  const { data, error } = await db
    .from('barber_activity_events')
    .insert({
      actor_id: actorId,
      actor_role: actorRole,
      barber_id: barber.id,
      branch_id: finalBranchId,
      event_type: normalizedEventType,
      grace_minutes: lateState.grace_minutes,
      is_late: lateState.is_late,
      late_by_minutes: lateState.late_by_minutes,
      metadata: {
        ...eventMetadata,
        branch_timezone: timeZone,
      },
      occurred_at: actualOccurredAt.toISOString(),
      penalty_amount: parseNonNegativeNumber(penaltyAmount, 0),
      penalty_reason: normalizeText(penaltyReason),
      schedule_id: lateState.schedule_id,
      scheduled_start_at: lateState.scheduled_start_at,
      source: normalizeSource(source, 'barber_kiosk'),
    })
    .select('id, branch_id, barber_id, actor_id, actor_role, event_type, source, occurred_at, schedule_id, scheduled_start_at, grace_minutes, is_late, late_by_minutes, penalty_amount, penalty_reason, metadata, created_at, barber:barbers ( id, name ), branch:branches ( id, name )')
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (io && data?.branch_id) {
    io.to(`branch:${data.branch_id}`).emit('queue:update', {
      type: 'verifix_activity',
      branchId: data.branch_id,
      barberId: data.barber_id,
      eventType: data.event_type,
      isLate: data.is_late,
    });
  }

  return data;
}

class Verifix {
  async listEvents(req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;

    try {
      const {
        barber_id,
        branch_id,
        end_date,
        event_type,
        late_only,
        limit: limitParam,
        offset: offsetParam,
        start_date,
      } = req.query || {};
      const limit = Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 500);
      const offset = Math.max(parseInt(offsetParam, 10) || 0, 0);
      const requestedEventType = normalizeText(event_type);
      const lateOnly = parseBoolean(late_only, false);

      let query = db
        .from('barber_activity_events')
        .select('id, branch_id, barber_id, actor_id, actor_role, event_type, source, occurred_at, schedule_id, scheduled_start_at, grace_minutes, is_late, late_by_minutes, penalty_amount, penalty_reason, metadata, created_at, barber:barbers ( id, name ), branch:branches ( id, name )', { count: 'exact' })
        .order('occurred_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (start_date) {
        const start = /^\d{4}-\d{2}-\d{2}$/.test(String(start_date))
          ? `${start_date}T00:00:00.000Z`
          : String(start_date);
        query = query.gte('occurred_at', start);
      }

      if (end_date) {
        const end = /^\d{4}-\d{2}-\d{2}$/.test(String(end_date))
          ? `${end_date}T23:59:59.999Z`
          : String(end_date);
        query = query.lte('occurred_at', end);
      }

      if (requestedEventType && EVENT_TYPES.has(requestedEventType)) {
        query = query.eq('event_type', requestedEventType);
      }

      if (lateOnly) {
        query = query.eq('is_late', true);
      }

      if (ADMIN_ROLES.has(auth.role)) {
        if (branch_id) query = query.eq('branch_id', String(branch_id));
        if (barber_id) query = query.eq('barber_id', String(barber_id));
      } else if (BARBER_ROLES.has(auth.role)) {
        query = query.eq('barber_id', auth.id);
      } else {
        return res.status(403).json({ error: 'Only admins or barbers can view Verifix events' });
      }

      const { data, error, count } = await query;
      if (error) return res.status(500).json({ error: error.message });

      return res.json({
        items: data || [],
        total: count || 0,
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async recordEvent(req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;

    try {
      const body = req.body || {};
      const isAdmin = ADMIN_ROLES.has(auth.role);
      const isBarber = BARBER_ROLES.has(auth.role);

      if (!isAdmin && !isBarber) {
        return res.status(403).json({ error: 'Only admins or barbers can record Verifix events' });
      }

      const eventType = normalizeEventType(body.event_type);
      if (!eventType) {
        return res.status(400).json({ error: 'Invalid event_type' });
      }

      const barberId = isAdmin ? normalizeId(body.barber_id) : auth.id;
      if (!barberId) {
        return res.status(400).json({ error: 'barber_id is required' });
      }

      const occurredAt = normalizeDateTime(body.occurred_at, new Date());
      if (!occurredAt) {
        return res.status(400).json({ error: 'occurred_at must be a valid date/time' });
      }

      const event = await recordActivityEvent({
        actorId: auth.id,
        actorRole: auth.role,
        barberId,
        branchId: isAdmin ? normalizeId(body.branch_id) : auth.branchId,
        eventType,
        io: req.app.get('io'),
        metadata: body.metadata,
        occurredAt,
        penaltyAmount: body.penalty_amount,
        penaltyReason: body.penalty_reason,
        source: normalizeSource(body.source, isAdmin ? 'dashboard' : 'barber_kiosk'),
      });

      return res.status(201).json({ event });
    } catch (error) {
      const status = /not found/i.test(error.message) ? 404 : 400;
      return res.status(status).json({ error: error.message });
    }
  }

  async startShift(req, res) {
    return this.setShiftState(req, res, {
      eventType: 'shift_start',
      isOnShift: true,
      metadataFlag: 'manual_shift_start',
    });
  }

  async endShift(req, res) {
    return this.setShiftState(req, res, {
      eventType: 'shift_end',
      isOnShift: false,
      metadataFlag: 'manual_shift_end',
    });
  }

  async setShiftState(req, res, { eventType, isOnShift, metadataFlag }) {
    const auth = requireAuth(req, res);
    if (!auth) return;

    try {
      const isAdmin = ADMIN_ROLES.has(auth.role);
      const isBarber = BARBER_ROLES.has(auth.role);
      if (!isAdmin && !isBarber) {
        return res.status(403).json({ error: 'Only admins or barbers can change shift state' });
      }

      const body = req.body || {};
      const barberId = isAdmin ? normalizeId(body.barber_id) : auth.id;
      if (!barberId) return res.status(400).json({ error: 'barber_id is required' });

      const currentBarber = await getBarber(barberId);
      if (!currentBarber) return res.status(404).json({ error: 'Barber not found' });

      const branchId = normalizeId(body.branch_id) || currentBarber.branch_id || auth.branchId;
      if (!branchId) return res.status(400).json({ error: 'branch_id is required' });

      const branch = await getBranch(branchId);
      if (!branch) return res.status(404).json({ error: 'Branch not found' });

      const barberUpdate = { is_on_shift: isOnShift };
      if (branchId !== currentBarber.branch_id) barberUpdate.branch_id = branchId;

      const { data: updatedBarber, error: updateError } = await db
        .from('barbers')
        .update(barberUpdate)
        .eq('id', barberId)
        .select('id, name, branch_id, is_on_shift')
        .maybeSingle();

      if (updateError) return res.status(500).json({ error: updateError.message });
      if (!updatedBarber) return res.status(404).json({ error: 'Barber not found' });

      if (branchId !== currentBarber.branch_id) {
        await db.from('users').update({ branch_id: branchId }).eq('id', barberId);
      }

      const event = await recordActivityEvent({
        actorId: auth.id,
        actorRole: auth.role,
        barberId,
        branchId,
        eventType,
        io: req.app.get('io'),
        metadata: {
          ...(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {}),
          [metadataFlag]: true,
        },
        occurredAt: normalizeDateTime(body.occurred_at, new Date()),
        source: normalizeSource(body.source, isAdmin ? 'dashboard' : 'barber_kiosk'),
      });

      return res.json({ barber: updatedBarber, event });
    } catch (error) {
      const status = /not found/i.test(error.message) ? 404 : 400;
      return res.status(status).json({ error: error.message });
    }
  }

  async listSchedules(req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;

    try {
      const { barber_id, branch_id, active } = req.query || {};
      const activeFilter = parseBoolean(active, undefined);

      let query = db
        .from('barber_work_schedules')
        .select('id, branch_id, barber_id, day_of_week, start_time, end_time, grace_minutes, is_active, valid_from, valid_to, created_at, updated_at, barber:barbers ( id, name ), branch:branches ( id, name )')
        .order('day_of_week', { ascending: true })
        .order('start_time', { ascending: true });

      if (activeFilter !== undefined) query = query.eq('is_active', activeFilter);

      if (ADMIN_ROLES.has(auth.role)) {
        if (branch_id) query = query.eq('branch_id', String(branch_id));
        if (barber_id) query = query.eq('barber_id', String(barber_id));
      } else if (BARBER_ROLES.has(auth.role)) {
        query = query.or(`barber_id.eq.${auth.id},barber_id.is.null`);
        if (auth.branchId) query = query.eq('branch_id', auth.branchId);
      } else {
        return res.status(403).json({ error: 'Only admins or barbers can view Verifix schedules' });
      }

      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });

      return res.json({ items: data || [] });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async createSchedule(req, res) {
    const auth = requireAdmin(req, res);
    if (!auth) return;

    try {
      const body = req.body || {};
      const branchId = normalizeId(body.branch_id);
      const barberId = normalizeId(body.barber_id);
      const dayOfWeek = Number(body.day_of_week);
      const startTime = normalizeTime(body.start_time);
      const endTime = body.end_time === undefined || body.end_time === null || body.end_time === ''
        ? null
        : normalizeTime(body.end_time);

      if (!branchId) return res.status(400).json({ error: 'branch_id is required' });
      if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
        return res.status(400).json({ error: 'day_of_week must be an integer from 0 to 6' });
      }
      if (!startTime) return res.status(400).json({ error: 'start_time must be HH:mm or HH:mm:ss' });
      if (body.end_time !== undefined && body.end_time !== null && body.end_time !== '' && !endTime) {
        return res.status(400).json({ error: 'end_time must be HH:mm or HH:mm:ss' });
      }

      const { data, error } = await db
        .from('barber_work_schedules')
        .insert({
          barber_id: barberId,
          branch_id: branchId,
          day_of_week: dayOfWeek,
          end_time: endTime,
          grace_minutes: parseNonNegativeInteger(body.grace_minutes, 0),
          is_active: parseBoolean(body.is_active, true),
          start_time: startTime,
          valid_from: normalizeDate(body.valid_from),
          valid_to: normalizeDate(body.valid_to),
        })
        .select('id, branch_id, barber_id, day_of_week, start_time, end_time, grace_minutes, is_active, valid_from, valid_to, created_at, updated_at')
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ schedule: data });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async updateSchedule(req, res) {
    const auth = requireAdmin(req, res);
    if (!auth) return;

    try {
      const { id } = req.params || {};
      const body = req.body || {};
      if (!id) return res.status(400).json({ error: 'schedule id is required' });

      const update = { updated_at: new Date().toISOString() };

      if (body.branch_id !== undefined) {
        const branchId = normalizeId(body.branch_id);
        if (!branchId) return res.status(400).json({ error: 'branch_id cannot be empty' });
        update.branch_id = branchId;
      }

      if (body.barber_id !== undefined) update.barber_id = normalizeId(body.barber_id);

      if (body.day_of_week !== undefined) {
        const dayOfWeek = Number(body.day_of_week);
        if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
          return res.status(400).json({ error: 'day_of_week must be an integer from 0 to 6' });
        }
        update.day_of_week = dayOfWeek;
      }

      if (body.start_time !== undefined) {
        const startTime = normalizeTime(body.start_time);
        if (!startTime) return res.status(400).json({ error: 'start_time must be HH:mm or HH:mm:ss' });
        update.start_time = startTime;
      }

      if (body.end_time !== undefined) {
        if (body.end_time === null || body.end_time === '') {
          update.end_time = null;
        } else {
          const endTime = normalizeTime(body.end_time);
          if (!endTime) return res.status(400).json({ error: 'end_time must be HH:mm or HH:mm:ss' });
          update.end_time = endTime;
        }
      }

      if (body.grace_minutes !== undefined) update.grace_minutes = parseNonNegativeInteger(body.grace_minutes, 0);
      if (body.is_active !== undefined) update.is_active = parseBoolean(body.is_active, true);
      if (body.valid_from !== undefined) update.valid_from = normalizeDate(body.valid_from);
      if (body.valid_to !== undefined) update.valid_to = normalizeDate(body.valid_to);

      const { data, error } = await db
        .from('barber_work_schedules')
        .update(update)
        .eq('id', id)
        .select('id, branch_id, barber_id, day_of_week, start_time, end_time, grace_minutes, is_active, valid_from, valid_to, created_at, updated_at')
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Schedule not found' });

      return res.json({ schedule: data });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async deleteSchedule(req, res) {
    const auth = requireAdmin(req, res);
    if (!auth) return;

    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'schedule id is required' });

      const { data, error } = await db
        .from('barber_work_schedules')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('id, is_active')
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Schedule not found' });

      return res.json({ schedule: data });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
}

module.exports = Object.assign(new Verifix(), {
  recordActivityEvent,
});
