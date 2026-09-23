const jwt = require('jsonwebtoken');

const { pool } = require('../../config/postgres');
const { ALLOWED_KEYS, validateValue } = require('../../utils/marketplaceSettings');
const ADMIN_ROLES = new Set(['admin_network', 'admin']);

function authenticate(req, res) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
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
    try {
      const result = await pool.query(
        `select key, value, description, updated_at
           from platform_settings
          where key = any($1::text[])
          order by key`,
        [Array.from(ALLOWED_KEYS)],
      );
      return res.json({ settings: result.rows });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async update(req, res) {
    const administrator = authenticate(req, res);
    if (!administrator) return;
    const key = String(req.params?.key || '').trim();
    const value = req.body?.value;
    if (!ALLOWED_KEYS.has(key)) {
      return res.status(400).json({ error: 'Unsupported platform setting' });
    }
    const validationError = validateValue(key, value);
    if (validationError) return res.status(400).json({ error: validationError });

    const actor = String(administrator.sub || administrator.id || administrator.login || 'admin');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `insert into platform_settings (key, value, updated_at)
         values ($1, $2::jsonb, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()
         returning key, value, description, updated_at`,
        [key, JSON.stringify(value)],
      );
      await client.query(
        `insert into marketplace_audit_logs (action, entity_type, entity_id, metadata)
         values ($1, 'platform_setting', $2, $3::jsonb)`,
        ['PLATFORM_SETTING_UPDATED', key, JSON.stringify({ actor, role: administrator.role })],
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
