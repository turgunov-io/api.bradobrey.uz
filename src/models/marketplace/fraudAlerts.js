const jwt = require('jsonwebtoken');

const { pool } = require('../../config/postgres');

const ADMIN_ROLES = new Set(['admin_network', 'admin_branch', 'admin', 'merchant']);
const ALERT_STATUSES = new Set(['OPEN', 'REVIEWED', 'DISMISSED']);

function auth(req, res) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization token is required' });
    return null;
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (!ADMIN_ROLES.has(payload?.role)) {
      res.status(403).json({ error: 'Only admins can manage fraud alerts' });
      return null;
    }
    return payload;
  } catch (_error) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
}

class FraudAlerts {
  async list(req, res) {
    const administrator = auth(req, res);
    if (!administrator) return;

    const status = String(req.query?.status || '').trim().toUpperCase();
    const kind = String(req.query?.kind || '').trim();
    if (status && !ALERT_STATUSES.has(status)) {
      return res.status(400).json({ error: 'status must be OPEN, REVIEWED or DISMISSED' });
    }
    const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query?.offset) || 0, 0);
    const params = [];
    const filters = [];
    if (status) {
      params.push(status);
      filters.push(`a.status = $${params.length}`);
    }
    if (kind) {
      params.push(kind);
      filters.push(`a.kind = $${params.length}`);
    }
    params.push(limit, offset);
    const where = filters.length ? `where ${filters.join(' and ')}` : '';

    try {
      const result = await pool.query(
        `select a.id, a.marketplace_client_id, mc.phone, mc.display_name,
                a.kind, a.source_ip, a.device_id, a.metadata, a.status,
                a.reviewed_at, a.reviewed_by, a.created_at
           from marketplace_fraud_alerts a
           left join marketplace_clients mc on mc.id = a.marketplace_client_id
           ${where}
          order by a.created_at desc
          limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      return res.json({ items: result.rows, limit, offset });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  async review(req, res) {
    const administrator = auth(req, res);
    if (!administrator) return;
    const id = String(req.params?.id || '').trim();
    const status = String(req.body?.status || '').trim().toUpperCase();
    if (!id || !ALERT_STATUSES.has(status) || status === 'OPEN') {
      return res.status(400).json({ error: 'status must be REVIEWED or DISMISSED' });
    }

    const reviewer = String(administrator.sub || administrator.id || administrator.login || 'admin').trim();
    try {
      const result = await pool.query(
        `update marketplace_fraud_alerts
            set status = $2, reviewed_at = now(), reviewed_by = $3
          where id = $1
          returning *`,
        [id, status, reviewer],
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Fraud alert not found' });
      await pool.query(
        `insert into marketplace_audit_logs (action, entity_type, entity_id, metadata)
         values ($1, 'marketplace_fraud_alert', $2, $3::jsonb)`,
        [`FRAUD_ALERT_${status}`, id, JSON.stringify({ reviewer, role: administrator.role })],
      );
      return res.json({ alert: result.rows[0] });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new FraudAlerts();
