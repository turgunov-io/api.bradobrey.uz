const bcrypt = require('bcryptjs');
const express = require('express');
const { randomUUID } = require('crypto');

const { supabase } = require('../config/supabaseClient');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const { signToken } = require('../utils/jwt');

const router = express.Router();

const roles = ['admin_network', 'admin_branch', 'barber'];

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const {
      login,
      password,
      role,
      branch_id: branchId,
      barber_name: barberName,
      photo_url: photoUrl,
      specialization,
    } = req.body || {};

    if (!login || !password || !role) {
      throw httpError(400, 'login, password, and role are required');
    }

    if (!roles.includes(role)) {
      throw httpError(400, `role must be one of: ${roles.join(', ')}`);
    }

    if (role === 'barber' && !barberName) {
      throw httpError(400, 'barber_name is required for barber role');
    }

    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('login', login)
      .maybeSingle();

    if (existing) {
      throw httpError(409, 'Login already exists');
    }

    const userId = randomUUID();
    const passwordHash = await bcrypt.hash(password, 10);

    const { error: userError } = await supabase.from('users').insert({
      id: userId,
      login,
      password_hash: passwordHash,
      role,
      branch_id: branchId || null,
    });

    if (userError) {
      throw httpError(500, userError.message);
    }

    let barber = null;
    if (role === 'barber') {
      const { data: barberData, error: barberError } = await supabase
        .from('barbers')
        .insert({
          id: userId,
          name: barberName,
          photo_url: photoUrl || null,
          branch_id: branchId || null,
          specialization: specialization || null,
          is_authorized: true,
          is_on_shift: false,
        })
        .select(
          'id, name, photo_url, branch_id, is_authorized, is_on_shift, specialization'
        )
        .single();

      if (barberError) {
        throw httpError(500, barberError.message);
      }

      barber = barberData;
    }

    const token = signToken({
      sub: userId,
      login,
      role,
      branchId: branchId || null,
      barberId: barber?.id || null,
    });

    res.status(201).json({
      token,
      user: {
        id: userId,
        login,
        role,
        branch_id: branchId || null,
      },
      barber,
    });
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { login, password, branch_id: branchOverride } = req.body || {};

    if (!login || !password) {
      throw httpError(400, 'Login and password are required');
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, login, password_hash, role, branch_id')
      .eq('login', login)
      .single();

    if (error || !user) {
      throw httpError(401, 'Invalid credentials');
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) {
      throw httpError(401, 'Invalid credentials');
    }

    if (user.role === 'barber' && !branchOverride) {
      throw httpError(400, 'branch_id is required for barber login');
    }

    let branchId = branchOverride || user.branch_id || null;
    let barber = null;
    if (user.role === 'barber') {
      const { data: barberData } = await supabase
        .from('barbers')
        .select(
          'id, name, photo_url, branch_id, is_authorized, is_on_shift, specialization'
        )
        .eq('id', user.id)
        .maybeSingle();

      if (!barberData) {
        throw httpError(
          400,
          'Barber profile is missing for this account (expected barbers.id = users.id)'
        );
      }

      barber = barberData;

      if (branchOverride && branchOverride !== barber.branch_id) {
        const { data: updatedBarber, error: barberUpdateError } = await supabase
          .from('barbers')
          .update({ branch_id: branchOverride })
          .eq('id', user.id)
          .select(
            'id, name, photo_url, branch_id, is_authorized, is_on_shift, specialization'
          )
          .maybeSingle();

        if (barberUpdateError) {
          throw httpError(500, barberUpdateError.message);
        }

        barber = updatedBarber || barber;
        branchId = branchOverride;
      } else if (!branchId) {
        branchId = barber.branch_id || null;
      }
    }

    if (branchId && branchId !== user.branch_id) {
      await supabase.from('users').update({ branch_id: branchId }).eq('id', user.id);
    }

    const token = signToken({
      sub: user.id,
      login: user.login,
      role: user.role,
      branchId,
      barberId: barber?.id || null,
    });

    res.json({
      token,
      user: {
        id: user.id,
        login: user.login,
        role: user.role,
        branch_id: branchId,
      },
      barber,
    });
  })
);

router.get(
  '/me',
  authenticate(),
  asyncHandler(async (req, res) => {
    const { data: user } = await supabase
      .from('users')
      .select('id, login, role, branch_id')
      .eq('id', req.user.id)
      .maybeSingle();

    let barber = null;
    if (req.user.role === 'barber' && req.user.barberId) {
      const { data: barberData } = await supabase
        .from('barbers')
        .select(
          'id, name, photo_url, branch_id, is_authorized, is_on_shift, specialization'
        )
        .eq('id', req.user.barberId)
        .maybeSingle();
      barber = barberData;
    }

    res.json({ user, barber });
  })
);

router.post('/logout', authenticate(), (req, res) => {
  res.status(204).send();
});

module.exports = router;
