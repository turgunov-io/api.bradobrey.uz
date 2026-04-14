const jwt = require('jsonwebtoken');

const { supabase } = require('../../config/supabase');
const {
  uploadBase64ToSupabase,
  uploadBufferToSupabase,
} = require('../../composable/uploadImage');

const MARKETPLACE_ROLE = 'marketplace';

const DEFAULT_AVATAR_URL_TEMPLATE =
  process.env.DEFAULT_AVATAR_URL_TEMPLATE ||
  'https://api.dicebear.com/7.x/identicon/svg?seed={seed}';

const getBearerToken = (req) => {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
};

const verifyJwt = (token) => {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET is not configured');
  return jwt.verify(token, jwtSecret);
};

const isMarketplacePayload = (payload) => payload?.role === MARKETPLACE_ROLE;

const normalizePhone = (phoneInput) => {
  const raw = String(phoneInput || '').trim();
  if (!raw) return null;

  // Keep leading "+" and digits, drop spaces / dashes / parentheses.
  const cleaned = raw.replace(/[\s()-]/g, '');
  return cleaned || null;
};

const isValidE164 = (phone) => /^\+\d{7,15}$/.test(phone || '');

const buildDefaultAvatarUrl = (seedInput) => {
  const seed = String(seedInput || 'user');
  return DEFAULT_AVATAR_URL_TEMPLATE.replace('{seed}', encodeURIComponent(seed));
};

const formatProfile = (row) => {
  const hasCustomPhoto = Boolean(row?.photo_url);
  return {
    id: row?.id,
    email: row?.email,
    phone: row?.phone || null,
    photo_url: row?.photo_url || buildDefaultAvatarUrl(row?.email || row?.id),
    photo_url_is_default: !hasCustomPhoto,
    phone_required: !row?.phone,
  };
};

class MarketplaceProfile {
  async _auth(req, res) {
    const token = getBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Authorization token is required' });
      return null;
    }

    let payload;
    try {
      payload = verifyJwt(token);
    } catch (_err) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return null;
    }

    if (!isMarketplacePayload(payload)) {
      res.status(403).json({ error: 'Only marketplace users can access this resource' });
      return null;
    }

    const clientId = payload.sub || payload.id;
    if (!clientId) {
      res.status(401).json({ error: 'Invalid token payload' });
      return null;
    }

    const { data: client, error } = await supabase
      .from('marketplace_clients')
      .select('id,email,phone,photo_url,is_active,created_at,last_login_at')
      .eq('id', clientId)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: error.message });
      return null;
    }

    if (!client) {
      res.status(404).json({ error: 'Marketplace client not found' });
      return null;
    }

    if (client.is_active === false) {
      res.status(403).json({ error: 'Account is disabled' });
      return null;
    }

    return { payload, client };
  }

  async me(req, res) {
    try {
      const auth = await this._auth(req, res);
      if (!auth) return;
      return res.json({ profile: formatProfile(auth.client) });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async updateMe(req, res) {
    try {
      const auth = await this._auth(req, res);
      if (!auth) return;

      const { phone, photo_url, image_base64, content_type } = req.body || {};

      const allowedKeys = ['phone', 'photo_url', 'image_base64', 'content_type'];
      if (req.body && Object.keys(req.body).some((k) => !allowedKeys.includes(k))) {
        return res.status(400).json({
          error:
            'Only profile updates are allowed (phone, photo_url, image_base64, content_type, or multipart file)',
        });
      }

      const hasPhoneUpdate = phone !== undefined;
      const hasPhotoUpdate =
        photo_url !== undefined || Boolean(image_base64) || Boolean(req.file);

      if (!hasPhoneUpdate && !hasPhotoUpdate) {
        return res.status(400).json({ error: 'Nothing to update' });
      }

      const updatePayload = {};

      let nextPhone = null;
      if (hasPhoneUpdate) {
        if (phone === null || String(phone).trim() === '') {
          nextPhone = null;
        } else {
          nextPhone = normalizePhone(phone);
          if (!nextPhone || !isValidE164(nextPhone)) {
            return res.status(400).json({ error: 'Invalid phone number. Expected E.164 format, e.g. +998991234567' });
          }

          const { data: existingPhoneOwner, error: phoneLookupError } = await supabase
            .from('marketplace_clients')
            .select('id')
            .eq('phone', nextPhone)
            .neq('id', auth.client.id)
            .maybeSingle();

          if (phoneLookupError) {
            return res.status(500).json({ error: phoneLookupError.message });
          }

          if (existingPhoneOwner?.id) {
            return res
              .status(409)
              .json({ error: 'Phone number is already attached to another account' });
          }
        }

        updatePayload.phone = nextPhone;
      }

      let finalPhotoUrl = null;
      if (hasPhotoUpdate) {
        // Precedence: uploaded file/base64 > explicit photo_url (including empty to clear)
        if (req.file) {
          const { buffer, mimetype } = req.file;
          const { data: uploadRes, error: uploadErr } = await uploadBufferToSupabase(
            buffer,
            mimetype || 'image/png',
            auth.client.id
          );
          if (uploadErr) {
            return res.status(500).json({ error: uploadErr.message || 'Failed to upload image' });
          }
          finalPhotoUrl = uploadRes?.publicUrl || null;
        } else if (image_base64) {
          const { data: uploadRes, error: uploadErr } = await uploadBase64ToSupabase(
            image_base64,
            content_type,
            auth.client.id
          );
          if (uploadErr) {
            return res.status(500).json({ error: uploadErr.message || 'Failed to upload image' });
          }
          finalPhotoUrl = uploadRes?.publicUrl || null;
          if (!finalPhotoUrl) {
            return res
              .status(500)
              .json({ error: 'Failed to generate public URL for uploaded image' });
          }
        } else if (photo_url !== undefined) {
          finalPhotoUrl = photo_url ? String(photo_url).trim() : null;
        } else {
          finalPhotoUrl = auth.client.photo_url || null;
        }

        updatePayload.photo_url = finalPhotoUrl;
      }

      const { data: updated, error: updateError } = await supabase
        .from('marketplace_clients')
        .update(updatePayload)
        .eq('id', auth.client.id)
        .select('id,email,phone,photo_url,is_active,created_at,last_login_at')
        .maybeSingle();

      if (updateError) {
        return res.status(500).json({ error: updateError.message });
      }

      if (hasPhoneUpdate && nextPhone) {
        await this._ensureClientRecordForPhone(nextPhone, updated?.email).catch(() => { });
      }

      return res.json({ profile: formatProfile(updated) });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async history(req, res) {
    try {
      const auth = await this._auth(req, res);
      if (!auth) return;

      const phone = auth.client.phone;
      if (!phone) {
        return res.status(428).json({
          error: 'Phone number is required to access history',
          code: 'PHONE_REQUIRED',
        });
      }

      const statusesParam = req.query?.status;
      const statusList = Array.isArray(statusesParam)
        ? statusesParam
        : statusesParam
          ? String(statusesParam).split(',').map((s) => s.trim()).filter(Boolean)
          : ['completed', 'cancelled', 'no_show', 'not_in_time'];

      const allowedStatuses = [
        'completed',
        'cancelled',
        'no_show',
        'not_in_time',
        'rejected',
      ];
      const validStatuses = statusList.filter((s) => allowedStatuses.includes(s));
      const finalStatuses = validStatuses.length ? validStatuses : allowedStatuses;

      const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);

      const { data: clientRow, error: clientErr } = await supabase
        .from('clients')
        .select('id,name,phone')
        .eq('phone', phone)
        .maybeSingle();

      if (clientErr) {
        return res.status(500).json({ error: clientErr.message });
      }

      if (!clientRow?.id) {
        return res.json({
          items: [],
          count: 0,
          limit,
          offset,
          phone,
          statuses: finalStatuses,
        });
      }

      const query = supabase
        .from('queue_entries')
        .select(
          `
            id,
            status,
            source,
            created_at,
            started_at,
            finished_at,
            service_id,
            service_ids,
            payment_method,
            branch:branches ( id, name, address, city ),
            barber:barbers ( id, name, photo_url ),
            service:services ( id, name, duration_minutes, base_price, category ),
            payments:payments ( amount, method, created_at )
          `,
          { count: 'exact' }
        )
        .eq('client_id', clientRow.id)
        .in('status', finalStatuses)
        .order('finished_at', { ascending: false })
        .range(offset, offset + limit - 1);

      const { data, error, count } = await query;

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      const entries = data || [];

      const serviceIds = new Set();
      for (const entry of entries) {
        if (entry?.service_id) serviceIds.add(entry.service_id);
        if (Array.isArray(entry?.service_ids)) {
          for (const id of entry.service_ids) {
            if (id) serviceIds.add(id);
          }
        }
      }

      const serviceMap = new Map();
      if (serviceIds.size > 0) {
        const { data: services, error: servicesError } = await supabase
          .from('services')
          .select('id,name,duration_minutes,base_price,category')
          .in('id', Array.from(serviceIds));

        if (servicesError) {
          return res.status(500).json({ error: servicesError.message });
        }

        for (const svc of services || []) {
          serviceMap.set(svc.id, svc);
        }
      }

      const formatted = entries.map((entry) => {
        const ids =
          Array.isArray(entry.service_ids) && entry.service_ids.length
            ? entry.service_ids
            : entry.service_id
              ? [entry.service_id]
              : [];

        const services = ids
          .map((id) => serviceMap.get(id) || null)
          .filter(Boolean);

        const total_price = services.reduce((sum, svc) => {
          const v = Number(svc.base_price);
          return sum + (Number.isFinite(v) ? v : 0);
        }, 0);

        return {
          id: entry.id,
          status: entry.status,
          source: entry.source || null,
          created_at: entry.created_at,
          started_at: entry.started_at || null,
          finished_at: entry.finished_at || null,
          payment_method: entry.payment_method || null,
          branch: entry.branch || null,
          barber: entry.barber || null,
          services,
          payments: entry.payments || [],
          total_price,
        };
      });

      return res.json({
        items: formatted,
        count: typeof count === 'number' ? count : entries.length,
        limit,
        offset,
        phone,
        statuses: finalStatuses,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async _ensureClientRecordForPhone(phone, email) {
    if (!phone) return;

    const { data: existing, error } = await supabase
      .from('clients')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();

    if (error) return;
    if (existing?.id) return;

    const fallbackName = String(email || 'Marketplace Client').split('@')[0] || 'Marketplace Client';

    const { error: insertError } = await supabase
      .from('clients')
      .insert({ name: fallbackName, phone });

    if (insertError) {
      // If it's a race/unique violation, ignore.
      return;
    }
  }
}

module.exports = new MarketplaceProfile();
