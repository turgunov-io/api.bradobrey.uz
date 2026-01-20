const express = require('express');

const { supabase } = require('../config/supabaseClient');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');

const router = express.Router();

const canManage = authenticate(['admin_network', 'admin_branch']);

// List services (optionally only active via ?active=true)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { active } = req.query;

    let query = supabase.from('services').select('*').order('name', { ascending: true });
    if (active === 'true') {
      query = query.eq('is_active', true);
    }

    const { data, error } = await query;
    if (error) {
      throw httpError(500, error.message);
    }

    res.json(data);
  })
);

// Get single service
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('services')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) {
      throw httpError(500, error.message);
    }
    if (!data) {
      throw httpError(404, 'Service not found');
    }

    res.json(data);
  })
);

// Create service (admins)
router.post(
  '/',
  canManage,
  asyncHandler(async (req, res) => {
    const { name, duration_minutes: durationMinutes, base_price: basePrice, is_active } =
      req.body || {};

    if (!name || typeof durationMinutes !== 'number' || durationMinutes <= 0) {
      throw httpError(400, 'name and positive duration_minutes are required');
    }

    const payload = {
      name,
      duration_minutes: durationMinutes,
      base_price: typeof basePrice === 'number' ? basePrice : null,
    };

    if (typeof is_active === 'boolean') {
      payload.is_active = is_active;
    }

    const { data, error } = await supabase.from('services').insert(payload).select().single();

    if (error) {
      throw httpError(500, error.message);
    }

    res.status(201).json(data);
  })
);

// Update service (admins)
router.patch(
  '/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const { name, duration_minutes: durationMinutes, base_price: basePrice, is_active } =
      req.body || {};

    const payload = {};
    if (typeof name === 'string') payload.name = name;
    if (typeof durationMinutes === 'number') payload.duration_minutes = durationMinutes;
    if (basePrice !== undefined) {
      payload.base_price = typeof basePrice === 'number' ? basePrice : null;
    }
    if (typeof is_active === 'boolean') payload.is_active = is_active;

    if (Object.keys(payload).length === 0) {
      throw httpError(400, 'No fields to update');
    }

    if (payload.duration_minutes !== undefined && payload.duration_minutes <= 0) {
      throw httpError(400, 'duration_minutes must be positive');
    }

    const { data, error } = await supabase
      .from('services')
      .update(payload)
      .eq('id', req.params.id)
      .select()
      .maybeSingle();

    if (error) {
      throw httpError(500, error.message);
    }
    if (!data) {
      throw httpError(404, 'Service not found');
    }

    res.json(data);
  })
);

// Activate service
router.post(
  '/:id/activate',
  canManage,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('services')
      .update({ is_active: true })
      .eq('id', req.params.id)
      .select()
      .maybeSingle();

    if (error) {
      throw httpError(500, error.message);
    }
    if (!data) {
      throw httpError(404, 'Service not found');
    }

    res.json(data);
  })
);

// Deactivate service
router.post(
  '/:id/deactivate',
  canManage,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('services')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .select()
      .maybeSingle();

    if (error) {
      throw httpError(500, error.message);
    }
    if (!data) {
      throw httpError(404, 'Service not found');
    }

    res.json(data);
  })
);

module.exports = router;
