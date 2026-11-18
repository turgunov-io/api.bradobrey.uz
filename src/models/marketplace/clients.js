const { db } = require('../../config/postgres');
const { createAdminAuth } = require('../../utils/adminAuth');
const { NETWORK_ROLES } = require('../../utils/employeeQualityAccess');

// Network-wide marketplace data (every client's phone, all reviews, push to
// any client): network roles only (admin_network, admin, super-manager). The
// role is loaded from the database by authorizeAdmin, never trusted from the
// JWT. admin_branch / merchant have no scoped use for these endpoints (dash
// merchant pages do not call them), so they are denied rather than scoped.
const authorizeNetworkAdmin = createAdminAuth({ roles: NETWORK_ROLES });

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
    const auth = await authorizeNetworkAdmin(req, res);
    if (!auth) return;

    try {
      const { active, q } = req.query || {};

      const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);

      let query = db
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
    const auth = await authorizeNetworkAdmin(req, res);
    if (!auth) return;

    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data, error } = await db
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
    const auth = await authorizeNetworkAdmin(req, res);
    if (!auth) return;

    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data, error } = await db
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
    const auth = await authorizeNetworkAdmin(req, res);
    if (!auth) return;

    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const { data, error } = await db
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

