const express = require('express');

const { supabase } = require('../config/supabaseClient');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');

const router = express.Router();

// List branches (optionally only active via ?active=true)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { active } = req.query;

    let query = supabase.from('branches').select('*').order('name', { ascending: true });
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

// Get single branch by id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('branches')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) {
      throw httpError(500, error.message);
    }
    if (!data) {
      throw httpError(404, 'Branch not found');
    }

    res.json(data);
  })
);

// Update branch (admin_network only)
router.patch(
  '/:id',
  authenticate(['admin_network']),
  asyncHandler(async (req, res) => {
    const {
      name,
      address,
      city,
      work_hours: workHours,
      timezone,
      is_active,
    } = req.body || {};

    const payload = {};
    if (typeof name === 'string') payload.name = name;
    if (address !== undefined) payload.address = address;
    if (city !== undefined) payload.city = city;
    if (workHours !== undefined) payload.work_hours = workHours;
    if (timezone !== undefined) payload.timezone = timezone;
    if (typeof is_active === 'boolean') payload.is_active = is_active;

    if (Object.keys(payload).length === 0) {
      throw httpError(400, 'No fields to update');
    }

    const { data, error } = await supabase
      .from('branches')
      .update(payload)
      .eq('id', req.params.id)
      .select()
      .maybeSingle();

    if (error) {
      throw httpError(500, error.message);
    }
    if (!data) {
      throw httpError(404, 'Branch not found');
    }

    res.json(data);
  })
);

// Create a branch (admin_network only)
router.post(
  '/',
  authenticate(['admin_network']),
  asyncHandler(async (req, res) => {
    const { name, address, city, work_hours: workHours, timezone, is_active } =
      req.body || {};

    if (!name) {
      throw httpError(400, 'name is required');
    }

    const payload = {
      name,
      address: address || null,
      city: city || null,
      work_hours: workHours || null,
      timezone: timezone || null,
    };

    if (typeof is_active === 'boolean') {
      payload.is_active = is_active;
    }

    const { data, error } = await supabase
      .from('branches')
      .insert(payload)
      .select()
      .single();

    if (error) {
      throw httpError(500, error.message);
    }

    res.status(201).json(data);
  })
);

// Deactivate branch
router.post(
  '/:id/deactivate',
  authenticate(['admin_network']),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('branches')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .select()
      .maybeSingle();

    if (error) {
      throw httpError(500, error.message);
    }
    if (!data) {
      throw httpError(404, 'Branch not found');
    }

    res.json(data);
  })
);

// Activate branch
router.post(
  '/:id/activate',
  authenticate(['admin_network']),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('branches')
      .update({ is_active: true })
      .eq('id', req.params.id)
      .select()
      .maybeSingle();

    if (error) {
      throw httpError(500, error.message);
    }
    if (!data) {
      throw httpError(404, 'Branch not found');
    }

    res.json(data);
  })
);

module.exports = router;
