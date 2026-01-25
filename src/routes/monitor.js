const express = require('express');

const { supabase } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const { initialsFromName } = require('../utils/formatters');
const { broadcastQueueUpdate } = require('../utils/realtime');
const {
  fetchQueueEntry,
  updateQueueEntry,
  calculateWaitMinutes,
} = require('../services/queueService');

const router = express.Router();

const allowedSources = ['point', 'site', 'admin'];
const paymentMethods = ['cash', 'card', 'certificate'];

const pickBarberWithShortestQueue = async (branchId) => {
  const { data: barbers, error: barbersError } = await supabase
    .from('barbers')
    .select('id, name, branch_id, is_on_shift, is_authorized, specialization')
    .eq('branch_id', branchId);

  if (barbersError) {
    throw httpError(500, barbersError.message);
  }

  const available = (barbers || []).filter(
    (b) => b.is_on_shift && b.is_authorized
  );

  if (!available.length) {
    return null;
  }

  const { data: queueData, error: queueError } = await supabase
    .from('queue_entries')
    .select('barber_id')
    .eq('branch_id', branchId)
    .in('status', ['waiting', 'called', 'in_progress']);

  if (queueError) {
    throw httpError(500, queueError.message);
  }

  const counts = new Map();
  (queueData || []).forEach((q) => {
    counts.set(q.barber_id, (counts.get(q.barber_id) || 0) + 1);
  });

  let selected = available[0];
  let selectedCount = counts.get(selected.id) || 0;

  available.slice(1).forEach((barber) => {
    const count = counts.get(barber.id) || 0;
    if (count < selectedCount) {
      selected = barber;
      selectedCount = count;
    }
  });

  return selected;
};

router.get(
  '/barbers',
  asyncHandler(async (req, res) => {
    const branchId = req.query.branch_id;

    if (!branchId) {
      throw httpError(400, 'branch_id is required');
    }

    const { data: barbers, error: barbersError } = await supabase
      .from('barbers')
      .select(
        'id, name, photo_url, branch_id, is_on_shift, is_authorized, specialization'
      )
      .eq('branch_id', branchId);

    if (barbersError) {
      throw httpError(500, barbersError.message);
    }

    const { data: queueEntries, error: queueError } = await supabase
      .from('queue_entries')
      .select(
        `
        id,
        barber_id,
        status,
        created_at,
        swapped_flag,
        client:clients ( name ),
        service:services ( name, duration_minutes )
      `
      )
      .eq('branch_id', branchId)
      .in('status', ['waiting', 'called', 'in_progress'])
      .order('created_at', { ascending: true });

    if (queueError) {
      throw httpError(500, queueError.message);
    }

    const grouped = new Map();
    (queueEntries || []).forEach((entry) => {
      if (!entry.barber_id) return;
      const clientInitials = initialsFromName(entry.client?.name || '');
      const item = { ...entry, client_initials: clientInitials };
      delete item.client;
      const list = grouped.get(entry.barber_id) || [];
      list.push(item);
      grouped.set(entry.barber_id, list);
    });

    const response = (barbers || []).map((barber) => ({
      ...barber,
      queue: grouped.get(barber.id) || [],
    }));

    res.json({ branch_id: branchId, barbers: response });
  })
);

router.post(
  '/queue',
  asyncHandler(async (req, res) => {
    const {
      client_name: clientName,
      phone,
      service_id: serviceId,
      service_ids: serviceIdsInput,
      barber_id: barberIdInput,
      branch_id: branchIdInput,
      source = 'point',
      payment_method: paymentMethodInput,
    } = req.body || {};

    const serviceIds = Array.isArray(serviceId)
      ? serviceId
      : Array.isArray(serviceIdsInput)
        ? serviceIdsInput
        : serviceId
          ? [serviceId]
          : [];

    if (!clientName || !phone || serviceIds.length === 0) {
      throw httpError(400, 'client_name, phone, and service_id/service_ids are required');
    }

    if (!allowedSources.includes(source)) {
      throw httpError(400, `source must be one of: ${allowedSources.join(', ')}`);
    }

    if (paymentMethodInput && !paymentMethods.includes(paymentMethodInput)) {
      throw httpError(400, `payment_method must be one of: ${paymentMethods.join(', ')}`);
    }

    let branchId = branchIdInput || null;
    let barberId = barberIdInput || null;

    if (!branchId && barberId) {
      const { data: barber } = await supabase
        .from('barbers')
        .select('branch_id')
        .eq('id', barberId)
        .maybeSingle();
      branchId = barber?.branch_id || null;
    }

    if (!branchId) {
      throw httpError(400, 'branch_id is required (or provide barber_id to infer)');
    }

    if (!barberId) {
      const selected = await pickBarberWithShortestQueue(branchId);
      if (!selected) {
        throw httpError(400, 'No available barbers for this branch');
      }
      barberId = selected.id;
    }

    const { data: services, error: serviceError } = await supabase
      .from('services')
      .select('id, is_active')
      .in('id', serviceIds);

    if (serviceError || !services || services.length === 0) {
      throw httpError(404, 'Service not found');
    }

    if (services.length !== serviceIds.length) {
      throw httpError(400, 'One or more service_ids are invalid');
    }

    const inactive = services.find((s) => s.is_active === false);
    if (inactive) {
      throw httpError(400, `Service ${inactive.id} is not active`);
    }

    const { data: existingClient } = await supabase
      .from('clients')
      .select('id, name')
      .eq('phone', phone)
      .maybeSingle();

    let clientId = existingClient?.id;
    if (!clientId) {
      const { data: newClient, error: clientError } = await supabase
        .from('clients')
        .insert({ name: clientName, phone })
        .select('id')
        .single();

      if (clientError) {
        throw httpError(500, clientError.message);
      }

      clientId = newClient.id;
    } else if (!existingClient.name) {
      await supabase.from('clients').update({ name: clientName }).eq('id', clientId);
    }

    const insertPayload = {
      client_id: clientId,
      branch_id: branchId,
      barber_id: barberId,
      service_id: serviceIds[0], // store primary selected service
      service_ids: serviceIds,
      source,
      status: 'waiting',
      payment_method: paymentMethodInput || null,
    };

    let inserted;
    let insertError;

    ({ data: inserted, error: insertError } = await supabase
      .from('queue_entries')
      .insert(insertPayload)
      .select('id')
      .single());

    const isMissingServiceIdsError = (err) =>
      Boolean(err?.message?.toLowerCase().includes('service_ids'));
    const isMissingPaymentMethodError = (err) =>
      Boolean(err?.message?.toLowerCase().includes('payment_method'));

    if (insertError && (isMissingServiceIdsError(insertError) || isMissingPaymentMethodError(insertError))) {
      const fallbackPayload = { ...insertPayload };
      if (isMissingServiceIdsError(insertError)) {
        delete fallbackPayload.service_ids;
      }
      if (isMissingPaymentMethodError(insertError)) {
        delete fallbackPayload.payment_method;
      }

      ({ data: inserted, error: insertError } = await supabase
        .from('queue_entries')
        .insert(fallbackPayload)
        .select('id')
        .single());
    }

    if (insertError) {
      throw httpError(500, insertError.message);
    }

    const entry = await fetchQueueEntry(inserted.id);
    const eta = await calculateWaitMinutes(barberId, entry.id);

    let selectedServices = [];
    const { data: selectedServicesData } = await supabase
      .from('services')
      .select('id, name, duration_minutes, base_price')
      .in('id', serviceIds);

    if (Array.isArray(selectedServicesData)) {
      selectedServices = selectedServicesData;
    }

    broadcastQueueUpdate(req.app, {
      type: 'enqueued',
      branchId,
      barberId,
      queueId: entry.id,
      status: entry.status,
    });

    res.status(201).json({
      entry: { ...entry, payment_method: entry.payment_method || paymentMethodInput || null },
      eta_minutes: eta,
      selected_service_ids: serviceIds,
      services: selectedServices,
      payment_method: entry.payment_method || paymentMethodInput || null,
    });
  })
);

router.get(
  '/queue/:id/status',
  asyncHandler(async (req, res) => {
    const entry = await fetchQueueEntry(req.params.id);

    const eta =
      entry.barber_id && ['waiting', 'called', 'in_progress'].includes(entry.status)
        ? await calculateWaitMinutes(entry.barber_id, entry.id)
        : null;

    res.json({
      id: entry.id,
      status: entry.status,
      branch_id: entry.branch_id,
      barber_id: entry.barber_id,
      eta_minutes: eta,
      created_at: entry.created_at,
    });
  })
);

router.post(
  '/queue/:id/cancel',
  asyncHandler(async (req, res) => {
    const entry = await fetchQueueEntry(req.params.id);

    if (['completed', 'cancelled', 'rejected'].includes(entry.status)) {
      throw httpError(409, `Cannot cancel status ${entry.status}`);
    }

    const updated = await updateQueueEntry(entry.id, {
      status: 'cancelled',
      finished_at: new Date().toISOString(),
    });

    broadcastQueueUpdate(req.app, {
      type: 'cancelled',
      branchId: updated.branch_id,
      barberId: updated.barber_id,
      queueId: updated.id,
      status: updated.status,
    });

    res.json(updated);
  })
);

module.exports = router;
