const jwt = require('jsonwebtoken');
const { pool } = require('../../config/postgres');
const catalogService = require('../../modules/marketplace/catalog/service');

function getClientId(req, res) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (payload?.role !== 'marketplace' || !(payload.sub || payload.id)) {
      res.status(403).json({ error: 'Marketplace user token is required' });
      return null;
    }
    return String(payload.sub || payload.id);
  } catch (_) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
}

async function create(req, res) {
  const marketplaceClientId = getClientId(req, res);
  if (!marketplaceClientId) return;
  const body = req.body || {};
  const branchId = String(body.branch_id || '').trim();
  const persons = Array.isArray(body.persons) ? body.persons : [];
  const requestId = String(body.request_id || req.get('Idempotency-Key') || '').trim() || null;
  if (persons.length > 4) {
    return res.status(400).json({ error: 'TOO_MANY_PERSONS' });
  }
  if (!branchId || persons.length < 1) {
    return res.status(400).json({ error: 'branch_id and 1 to 4 persons are required' });
  }

  const normalizedPersons = persons.map((person, index) => ({
    displayName: String(person?.display_name || person?.name || `Person ${index + 1}`).trim(),
    barberId: String(person?.barber_id || '').trim(),
    serviceIds: Array.isArray(person?.service_ids) ? person.service_ids.map(String).filter(Boolean) : [],
  }));
  if (normalizedPersons.some((person) => person.serviceIds.length > 3)) {
    return res.status(400).json({ error: 'TOO_MANY_SERVICES' });
  }
  if (normalizedPersons.some((person) => !person.barberId || person.serviceIds.length < 1)) {
    return res.status(400).json({ error: 'Each person needs a barber and 1 to 3 services' });
  }

  const allServiceIds = [...new Set(normalizedPersons.flatMap((person) => person.serviceIds))];
  const payloadHash = require('crypto').createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const clientResult = await dbClient.query(
      `select mc.id, mc.phone, mc.email, mc.is_active, mc.blocked_until,
              c.id as legacy_client_id
         from marketplace_clients mc
         left join clients c on c.phone = mc.phone
        where mc.id = $1 for update`,
      [marketplaceClientId]
    );
    const marketplaceClient = clientResult.rows[0];
    if (!marketplaceClient) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Marketplace client not found' }); }
    if (marketplaceClient.is_active === false) { await dbClient.query('ROLLBACK'); return res.status(403).json({ error: 'ACCOUNT_BLOCKED' }); }
    if (marketplaceClient.blocked_until && new Date(marketplaceClient.blocked_until) > new Date()) { await dbClient.query('ROLLBACK'); return res.status(403).json({ error: 'ACCOUNT_BLOCKED' }); }
    if (!marketplaceClient.phone) { await dbClient.query('ROLLBACK'); return res.status(428).json({ error: 'PHONE_REQUIRED' }); }

    if (requestId) {
      const prior = await dbClient.query(
        `select id, status, response, payload_hash from marketplace_idempotency_requests
          where request_id = $1 and marketplace_client_id = $2 for update`,
        [requestId, marketplaceClientId]
      );
      if (prior.rows[0]?.payload_hash && prior.rows[0].payload_hash !== payloadHash) {
        await dbClient.query('ROLLBACK');
        return res.status(409).json({ error: 'IDEMPOTENCY_KEY_REUSED' });
      }
      if (prior.rows[0]?.response) {
        await dbClient.query('ROLLBACK');
        return res.status(Number(prior.rows[0].status || 201)).json(prior.rows[0].response);
      }
      if (prior.rows[0]) {
        await dbClient.query('ROLLBACK');
        return res.status(409).json({ error: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' });
      }
      if (!prior.rows[0]) {
        await dbClient.query(
          `insert into marketplace_idempotency_requests (request_id, marketplace_client_id, operation, payload_hash)
           values ($1, $2, 'GROUP_BOOKING', $3)`,
          [requestId, marketplaceClientId, payloadHash]
        );
      }
    }

    const branchResult = await dbClient.query('select id, timezone, work_hours, marketplace_barbershop_id, is_active from branches where id = $1', [branchId]);
    if (!branchResult.rows[0] || branchResult.rows[0].is_active === false) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Branch not found' }); }

    const limitsResult = await dbClient.query(`select value from platform_settings where key = 'booking_limits'`);
    const limits = limitsResult.rows[0]?.value || {};
    const dailyLimit = Number(limits.max_daily_bookings || 5);
    const dailyCount = await dbClient.query(
      `select count(*)::int as count from marketplace_bookings
        where marketplace_client_id = $1
          and (created_at at time zone coalesce($2, 'Asia/Tashkent'))::date =
              (now() at time zone coalesce($2, 'Asia/Tashkent'))::date`,
      [marketplaceClientId, branchResult.rows[0].timezone || 'Asia/Tashkent']
    );
    if (Number(dailyCount.rows[0]?.count || 0) >= dailyLimit) {
      await dbClient.query('ROLLBACK');
      return res.status(429).json({ error: 'DAILY_LIMIT_REACHED' });
    }
    const cooldown = await dbClient.query(
      `select cooldown_until from marketplace_bookings
        where marketplace_client_id = $1 and cooldown_until > now()
        order by cooldown_until desc limit 1`, [marketplaceClientId]
    );
    if (cooldown.rows[0]) {
      await dbClient.query('ROLLBACK');
      return res.status(429).json({ error: 'CANCEL_COOLDOWN_ACTIVE', cooldown_until: cooldown.rows[0].cooldown_until });
    }

    if (branchResult.rows[0].marketplace_barbershop_id) {
      await dbClient.query(
        `insert into client_barbershop_origins (marketplace_client_id, barbershop_id)
         values ($1, $2)
         on conflict (marketplace_client_id, barbershop_id) do update set
           last_booking_at = now(), booking_count = client_barbershop_origins.booking_count + 1, updated_at = now()`,
        [marketplaceClientId, branchResult.rows[0].marketplace_barbershop_id]
      );
    }

    const barbersResult = await dbClient.query(
      `select id from barbers where id = any($1::uuid[]) and branch_id = $2 and is_active = true and is_archived = false`,
      [normalizedPersons.map((person) => person.barberId), branchId]
    );
    if (barbersResult.rows.length !== new Set(normalizedPersons.map((person) => person.barberId)).size) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'One or more barbers are not available for this branch' }); }

    const servicesResult = await dbClient.query(
      `select id, duration_minutes, base_price from services where id = any($1::uuid[]) and is_active = true and (branch_id is null or branch_id = $2)`,
      [allServiceIds, branchId]
    );
    if (servicesResult.rows.length !== allServiceIds.length) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'SERVICE_NOT_AVAILABLE_TODAY' }); }
    const serviceById = new Map(servicesResult.rows.map((service) => [String(service.id), service]));
    const totalMinutes = normalizedPersons.reduce((sum, person) => sum + person.serviceIds.reduce((inner, serviceId) => inner + Number(serviceById.get(serviceId).duration_minutes || 0), 0), 0);
    if (totalMinutes > Number(limits.max_duration_minutes || 180)) { await dbClient.query('ROLLBACK'); return res.status(400).json({ error: 'DURATION_EXCEEDED' }); }

    try {
      for (const person of normalizedPersons) {
        const personDuration = person.serviceIds.reduce(
          (sum, serviceId) => sum + Number(serviceById.get(serviceId).duration_minutes || 0),
          0,
        );
        await catalogService.ensureBookingWithinWorkHours({
          branch: branchResult.rows[0],
          barberId: person.barberId,
          startsAt: new Date(),
          durationMinutes: personDuration,
        });
      }
    } catch (hoursError) {
      await dbClient.query('ROLLBACK');
      return res.status(hoursError.statusCode || 400).json({ error: hoursError.code || hoursError.message });
    }

    const bookingResult = await dbClient.query(
      `insert into marketplace_bookings (marketplace_client_id, source, status, request_id)
       values ($1, 'MARKETPLACE', 'ACTIVE', $2) returning *`,
      [marketplaceClientId, requestId]
    );
    const booking = bookingResult.rows[0];
    await dbClient.query(
      `insert into marketplace_notifications (marketplace_client_id, type, payload)
       values ($1, 'BOOKING_CREATED', $2::jsonb)`,
      [marketplaceClientId, JSON.stringify({ booking_id: booking.id })]
    );
    const legacyClientResult = marketplaceClient.legacy_client_id
      ? { rows: [{ id: marketplaceClient.legacy_client_id }] }
      : await dbClient.query(
        `insert into clients (name, phone) values ($1, $2) returning id`,
        [normalizedPersons[0].displayName, marketplaceClient.phone]
      );
    const legacyClientId = legacyClientResult.rows[0].id;
    const createdPersons = [];
    for (let index = 0; index < normalizedPersons.length; index += 1) {
      const person = normalizedPersons[index];
      const serviceIds = person.serviceIds;
      const entryResult = await dbClient.query(
        `insert into queue_entries (client_id, branch_id, barber_id, service_id, service_ids, source, status)
         values ($1, $2, $3, $4, $5::uuid[], 'site', 'waiting') returning id, status, created_at`,
        [legacyClientId, branchId, person.barberId, serviceIds[0], serviceIds]
      );
      const entry = entryResult.rows[0];
      const personResult = await dbClient.query(
        `insert into marketplace_booking_persons (booking_id, person_index, display_name, barber_id, queue_entry_id)
         values ($1, $2, $3, $4, $5) returning id, person_index, display_name, barber_id, queue_entry_id`,
        [booking.id, index + 1, person.displayName, person.barberId, entry.id]
      );
      await dbClient.query(
        `insert into marketplace_booking_person_services (person_id, service_id, price, duration_minutes)
         select $1, id, coalesce(base_price, 0), duration_minutes from services where id = any($2::uuid[])`,
        [personResult.rows[0].id, serviceIds]
      );
      createdPersons.push({ ...personResult.rows[0], service_ids: serviceIds, queue_entry: entry });
    }
    const response = { booking: { ...booking, persons: createdPersons } };
    if (requestId) {
      await dbClient.query(
        `update marketplace_idempotency_requests set status = 201, response = $2::jsonb, completed_at = now() where request_id = $1`,
        [requestId, JSON.stringify(response)]
      );
    }
    await dbClient.query(
      `insert into marketplace_audit_logs (marketplace_client_id, action, entity_type, entity_id, request_id, metadata)
       values ($1, 'GROUP_BOOKING_CREATED', 'marketplace_booking', $2, $3, $4::jsonb)`,
      [marketplaceClientId, booking.id, requestId, JSON.stringify({ persons: normalizedPersons.length, total_minutes: totalMinutes })]
    );
    await dbClient.query('COMMIT');
    const io = req.app.get('io');
    if (io) {
      io.to(`branch:${branchId}`).emit('booking.created', {
        type: 'booking_created',
        bookingId: booking.id,
        branchId,
        source: 'MARKETPLACE',
        queueEntryIds: createdPersons.map((person) => person.queue_entry?.id).filter(Boolean),
      });
    }
    return res.status(201).json(response);
  } catch (error) {
    try { await dbClient.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (error.code === '23505') return res.status(409).json({ error: 'ALREADY_HAS_ACTIVE_BOOKING' });
    console.error(error);
    return res.status(500).json({ error: error.message || 'Failed to create group booking' });
  } finally {
    dbClient.release();
  }
}

module.exports = { create };
