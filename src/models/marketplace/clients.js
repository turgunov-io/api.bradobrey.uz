const jwt = require('jsonwebtoken');

const { supabase } = require('../../config/supabase');

const ADMIN_ROLES = new Set(['admin_network', 'admin_branch', 'admin', 'merchant']);

const getBearerToken = (req) => {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
};

const requireAdmin = (req, res) => {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (_err) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }

  if (!ADMIN_ROLES.has(payload?.role)) {
    res.status(403).json({ error: 'Only admins can manage marketplace clients' });
    return null;
  }

  return payload;
};

const parseBoolean = (value, fallback = undefined) => {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const selectFields = 'id,email,phone,photo_url,is_active,created_at,last_login_at';

class MarketplaceClients {
  async list(req, res) {
    const auth = requireAdmin(req, res);
    if (!auth) return;

    try {
      const { active, q } = req.query || {};

      const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);

      let query = supabase
        .from('marketplace_clients')
        .select(selectFields, { count: 'exact' });

      if (active !== undefined) {
        const activeFlag = parseBoolean(active, null);
        if (activeFlag === null) {
          return res.status(400).json({ error: 'active must be a boolean' });
        }
        query = query.eq('is_active', activeFlag);
      }

      const needleRaw = typeof q === 'string' ? q.trim() : '';
      if (needleRaw) {
        const needle = needleRaw.replace(/,/g, '');
        query = query.or(`email.ilike.%${needle}%,phone.ilike.%${needle}%`);
      }

      const { data, error, count } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) return res.status(500).json({ error: error.message });

      return res.json({
        items: data || [],
        count: typeof count === 'number' ? count : (data || []).length,
        limit,
        offset,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async getById(req, res) {
    const auth = requireAdmin(req, res);
    if (!auth) return;

    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data, error } = await supabase
        .from('marketplace_clients')
        .select(selectFields)
        .eq('id', id)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Marketplace client not found' });

      return res.json({ entry: data });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async activate(req, res) {
    const auth = requireAdmin(req, res);
    if (!auth) return;

    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data, error } = await supabase
        .from('marketplace_clients')
        .update({ is_active: true })
        .eq('id', id)
        .select(selectFields)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Marketplace client not found' });

      return res.json({ entry: data });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async deactivate(req, res) {
    const auth = requireAdmin(req, res);
    if (!auth) return;

    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data, error } = await supabase
        .from('marketplace_clients')
        .update({ is_active: false })
        .eq('id', id)
        .select(selectFields)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Marketplace client not found' });

      return res.json({ entry: data });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }
}

module.exports = new MarketplaceClients();

