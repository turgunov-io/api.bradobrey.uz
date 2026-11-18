const { pool } = require('../../config/postgres');
const { createAdminAuth } = require('../../utils/adminAuth');
const { NETWORK_ROLES } = require('../../utils/employeeQualityAccess');
const { companyMarketplaceClientIdsSql, requireAdminCompany } = require('../../utils/marketplaceCompanyScope');

// Marketplace clients (every client's phone): network roles only
// (admin_network, admin, super-manager). The role is loaded from the database
// by authorizeAdmin, never trusted from the JWT. admin_branch / merchant have
// no scoped use for these endpoints (dash merchant pages do not call them), so
// they are denied rather than scoped.
//
// MULTI_TENANCY B2: "network" = the admin's company. marketplace_clients are
// global until Phase 5; an admin only sees (and can (de)activate) clients with
// a footprint in their company — see utils/marketplaceCompanyScope.js.
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

const SELECT_FIELDS = 'id, email, phone, photo_url, is_active, created_at, last_login_at';

// Escapes LIKE wildcards so a search is a plain substring match.
const likeNeedle = (value) => `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

async function authorizeCompanyAdmin(req, res) {
  const auth = await authorizeNetworkAdmin(req, res);
  if (!auth) return null;
  return requireAdminCompany(auth, res);
}

class MarketplaceClients {
  async list(req, res) {
    const companyId = await authorizeCompanyAdmin(req, res);
    if (!companyId) return;

    try {
      const { active, q } = req.query || {};

      const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);

      let activeFlag = null;
      if (active !== undefined) {
        activeFlag = parseBoolean(active, null);
        if (activeFlag === null) {
          return res.status(400).json({ error: 'active must be a boolean' });
        }
      }
      const needleRaw = typeof q === 'string' ? q.trim() : '';
      const needle = needleRaw ? likeNeedle(needleRaw) : null;

      const result = await pool.query(
        `select ${SELECT_FIELDS}, count(*) over()::int as total_count
           from marketplace_clients
          where id in (${companyMarketplaceClientIdsSql('$1')})
            and ($2::boolean is null or is_active = $2)
            and ($3::text is null or coalesce(email, '') ilike $3 or coalesce(phone, '') ilike $3)
          order by created_at desc
          limit $4 offset $5`,
        [companyId, activeFlag, needle, limit, offset],
      );
      const rows = result.rows || [];
      return res.json({
        items: rows.map(({ total_count: _total, ...item }) => item),
        count: rows[0]?.total_count || 0,
        limit,
        offset,
      });
    } catch (error) {
      console.error('[marketplace-clients] list failed:', error?.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  async getById(req, res) {
    const companyId = await authorizeCompanyAdmin(req, res);
    if (!companyId) return;

    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const result = await pool.query(
        `select ${SELECT_FIELDS}
           from marketplace_clients
          where id = $1 and id in (${companyMarketplaceClientIdsSql('$2')})
          limit 1`,
        [id, companyId],
      );
      const entry = result.rows?.[0];
      if (!entry) return res.status(404).json({ error: 'Marketplace client not found' });

      return res.json({ entry });
    } catch (error) {
      console.error('[marketplace-clients] get failed:', error?.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  async setActive(req, res, isActive) {
    const companyId = await authorizeCompanyAdmin(req, res);
    if (!companyId) return;

    try {
      const { id } = req.params || {};
      if (!id) return res.status(400).json({ error: 'id is required' });

      const result = await pool.query(
        `update marketplace_clients
            set is_active = $3
          where id = $1 and id in (${companyMarketplaceClientIdsSql('$2')})
          returning ${SELECT_FIELDS}`,
        [id, companyId, isActive],
      );
      const entry = result.rows?.[0];
      if (!entry) return res.status(404).json({ error: 'Marketplace client not found' });

      return res.json({ entry });
    } catch (error) {
      console.error('[marketplace-clients] update failed:', error?.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  async activate(req, res) {
    return this.setActive(req, res, true);
  }

  async deactivate(req, res) {
    return this.setActive(req, res, false);
  }
}

module.exports = new MarketplaceClients();
