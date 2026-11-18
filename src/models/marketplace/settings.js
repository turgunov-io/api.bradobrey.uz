const { verifyAny } = require('../../utils/authToken');

const { pool } = require('../../config/postgres');
const { ALLOWED_KEYS, validateValue } = require('../../utils/marketplaceSettings');
const ADMIN_ROLES = new Set(['admin_network', 'admin']);

// Company scope (MULTI_TENANCY B2a): platform_settings rows are keyed by
// (company_id, key). The company is req.tenant (DB-loaded by the global
// employeeAccess middleware for staff tokens), never the request body.
const tenantCompanyOf = (req) => req?.tenant?.companyId || null;

function authenticate(req, res) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }
  try {
    const payload = verifyAny(header.slice(7));
    if (!ADMIN_ROLES.has(payload?.role)) {
      res.status(403).json({ error: 'Only network admins can manage platform settings' });
      return null;
    }
    return payload;
  } catch (_) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
}

class MarketplaceSettings {
  async list(req, res) {
    if (!authenticate(req, res)) return;
    const companyId = tenantCompanyOf(req);
    if (!companyId) return res.status(403).json({ code: 'COMPANY_REQUIRED', error: 'Company context is required' });
    try {
      const result = await pool.query(
        `select key, value, description, updated_at
           from platform_settings
          where company_id = $2
            and key = any($1::text[])
          order by key`,
        [Array.from(ALLOWED_KEYS), companyId],
      );
      return res.json({ settings: result.rows });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async update(req, res) {
    const administrator = authenticate(req, res);
    if (!administrator) return;
    const companyId = tenantCompanyOf(req);
    if (!companyId) return res.status(403).json({ code: 'COMPANY_REQUIRED', error: 'Company context is required' });
    const key = String(req.params?.key || '').trim();
    const requestValue = req.body?.value;
    if (!ALLOWED_KEYS.has(key)) {
      return res.status(400).json({ error: 'Unsupported platform setting' });
    }
    // Older Dashboard bundles mirrored the response timestamp into the form
    // and sent it back on PATCH. It is server-owned metadata, not a setting;
    // discard only this known legacy field before the strict allowlist check.
    const value = key === 'no_show_restrictions'
      && requestValue && typeof requestValue === 'object' && !Array.isArray(requestValue)
      ? (() => {
        const { updated_at, ...settingsValue } = requestValue;
        void updated_at;
        return settingsValue;
      })()
      : requestValue;
    const validationError = validateValue(key, value);
    if (validationError) return res.status(400).json({ error: validationError });

    const actor = String(administrator.sub || administrator.id || administrator.login || 'admin');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `insert into platform_settings (company_id, key, value, updated_at)
         values ($3, $1, $2::jsonb, now())
         on conflict (company_id, key) do update set value = excluded.value, updated_at = now()
         returning key, value, description, updated_at`,
        [key, JSON.stringify(value), companyId],
      );
      await client.query(
        `insert into marketplace_audit_logs (action, entity_type, entity_id, metadata)
         values ($1, 'platform_setting', null, $2::jsonb)`,
        [
          'PLATFORM_SETTING_UPDATED',
          JSON.stringify({ actor, role: administrator.role, key, company_id: companyId }),
        ],
      );
      await client.query('COMMIT');
      return res.json({ setting: result.rows[0] });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      return res.status(500).json({ error: error.message });
    } finally {
      client.release();
    }
  }
}

module.exports = new MarketplaceSettings();
