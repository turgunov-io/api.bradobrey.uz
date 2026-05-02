const jwt = require('jsonwebtoken');

const { supabase } = require('../config/supabase');

const ADMIN_ROLES = new Set(['admin_network', 'admin_branch', 'admin']);

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
    res.status(403).json({ error: 'Only admins can manage loyalty settings' });
    return null;
  }

  return payload;
};

const toPositiveIntOrNull = (value) => {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
};

class Loyalty {
  async getRankSettings(req, res) {
    const auth = requireAdmin(req, res);
    if (!auth) return;

    const { data, error } = await supabase
      .from('client_rank_settings')
      .select('id, bronze_min_visits, silver_min_visits, gold_min_visits, updated_at')
      .eq('id', 1)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (data) return res.json({ settings: data });

    const { data: created, error: createError } = await supabase
      .from('client_rank_settings')
      .insert({ id: 1 })
      .select('id, bronze_min_visits, silver_min_visits, gold_min_visits, updated_at')
      .maybeSingle();

    if (createError) {
      return res.status(500).json({ error: createError.message });
    }

    return res.json({ settings: created });
  }

  async updateRankSettings(req, res) {
    const auth = requireAdmin(req, res);
    if (!auth) return;

    const { bronze_min_visits, silver_min_visits, gold_min_visits } = req.body || {};

    const bronze = toPositiveIntOrNull(bronze_min_visits);
    const silver = toPositiveIntOrNull(silver_min_visits);
    const gold = toPositiveIntOrNull(gold_min_visits);

    if (bronze_min_visits !== undefined && bronze === null) {
      return res.status(400).json({ error: 'bronze_min_visits must be a positive integer' });
    }
    if (silver_min_visits !== undefined && silver === null) {
      return res.status(400).json({ error: 'silver_min_visits must be a positive integer' });
    }
    if (gold_min_visits !== undefined && gold === null) {
      return res.status(400).json({ error: 'gold_min_visits must be a positive integer' });
    }

    const { data: current, error: currentError } = await supabase
      .from('client_rank_settings')
      .select('id, bronze_min_visits, silver_min_visits, gold_min_visits')
      .eq('id', 1)
      .maybeSingle();

    if (currentError) {
      return res.status(500).json({ error: currentError.message });
    }

    const next = {
      bronze_min_visits: bronze ?? current?.bronze_min_visits ?? 2,
      silver_min_visits: silver ?? current?.silver_min_visits ?? 5,
      gold_min_visits: gold ?? current?.gold_min_visits ?? 10,
    };

    if (!(next.silver_min_visits > next.bronze_min_visits)) {
      return res.status(400).json({ error: 'silver_min_visits must be > bronze_min_visits' });
    }

    if (!(next.gold_min_visits > next.silver_min_visits)) {
      return res.status(400).json({ error: 'gold_min_visits must be > silver_min_visits' });
    }

    const payload = { id: 1 };
    if (bronze !== null) payload.bronze_min_visits = bronze;
    if (silver !== null) payload.silver_min_visits = silver;
    if (gold !== null) payload.gold_min_visits = gold;

    if (Object.keys(payload).length === 1) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const { data: updated, error: updateError } = await supabase
      .from('client_rank_settings')
      .upsert(payload, { onConflict: 'id' })
      .select('id, bronze_min_visits, silver_min_visits, gold_min_visits, updated_at')
      .eq('id', 1)
      .maybeSingle();

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    return res.json({ settings: updated });
  }
}

module.exports = new Loyalty();

