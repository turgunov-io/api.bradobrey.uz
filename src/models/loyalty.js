const { db } = require('../config/postgres');
const { DEFAULT_LOYALTY_LEVELS, validateLoyaltyLevels } = require('../utils/loyaltyLevels');
const { requireAdmin } = require('../utils/adminAuth');
const LEGACY_RANK_DEFAULTS = Object.freeze({ bronze_min_visits: 2, silver_min_visits: 5, gold_min_visits: 10 });

const listLevels = (value) => Object.entries(value || {})
  .map(([name, config]) => ({
    name,
    min_points: Number(config?.min_points) || 0,
    cashback_percent: Number(config?.cashback_percent) || 0,
    cancel_penalty_points: Number(config?.cancel_penalty_points ?? 10),
    no_show_penalty_points: Number(config?.no_show_penalty_points ?? 30),
  }))
  .sort((a, b) => a.min_points - b.min_points);

class Loyalty {
  async readLevels() {
    const { data, error } = await db.from('platform_settings').select('value, updated_at').eq('key', 'loyalty_levels').maybeSingle();
    if (error) throw new Error(error.message);
    return {
      value: data?.value && Object.keys(data.value).length ? data.value : DEFAULT_LOYALTY_LEVELS,
      updated_at: data?.updated_at || null,
    };
  }

  async getPublicRankSettings(_req, res) {
    try {
      const levels = await this.readLevels();
      return res.json({ levels: listLevels(levels.value), updated_at: levels.updated_at });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to read loyalty settings' });
    }
  }

  async getRankSettings(req, res) {
    if (!requireAdmin(req, res)) return;
    try {
      const [levels, legacy] = await Promise.all([
        this.readLevels(),
        db.from('client_rank_settings')
          .select('id, bronze_min_visits, silver_min_visits, gold_min_visits, updated_at')
          .eq('id', 1).maybeSingle(),
      ]);
      if (legacy.error) throw new Error(legacy.error.message);
      return res.json({
        settings: {
          ...LEGACY_RANK_DEFAULTS,
          ...(legacy.data || {}),
          levels: listLevels(levels.value),
          legacy_updated_at: legacy.data?.updated_at || null,
          updated_at: levels.updated_at,
        },
      });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to read loyalty settings' });
    }
  }

  async updateRankSettings(req, res) {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    const body = req.body || {};

    // Keep accepting the original visit-based payload for older dashboard builds.
    if (body.levels === undefined && body.loyalty_levels === undefined) {
      return this.updateLegacyRankSettings(body, res);
    }

    const candidate = body.levels ?? body.loyalty_levels;
    const asMap = Array.isArray(candidate)
      ? Object.fromEntries(candidate.map((level) => [level?.name, {
        min_points: level?.min_points,
        cashback_percent: level?.cashback_percent ?? 0,
        cancel_penalty_points: level?.cancel_penalty_points,
        no_show_penalty_points: level?.no_show_penalty_points,
      }]))
      : candidate;
    const validation = validateLoyaltyLevels(asMap);
    if (validation.error) return res.status(400).json({ error: validation.error });

    try {
      const before = await this.readLevels();
      const { data, error } = await db.from('platform_settings')
        .upsert({
          key: 'loyalty_levels',
          value: validation.value,
          description: 'Marketplace status point levels',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'key' })
        .select('value, updated_at').eq('key', 'loyalty_levels').maybeSingle();
      if (error) throw new Error(error.message);
      const settings = data?.value || validation.value;

      // Existing audit log supports metadata-only setting events.
      try {
        await db.query(
          `insert into marketplace_audit_logs (action, entity_type, metadata)
           values ('LOYALTY_LEVELS_UPDATED', 'platform_setting', $1::jsonb)`,
          [JSON.stringify({ admin_id: auth.sub || auth.id || null, admin_role: auth.role, before: before.value, after: settings })],
        );
      } catch (auditError) {
        console.error('Failed to record loyalty settings audit event:', auditError.message);
      }
      return res.json({ settings: { levels: listLevels(settings), updated_at: data?.updated_at || null } });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to update loyalty settings' });
    }
  }

  async updateLegacyRankSettings(body, res) {
    const { bronze_min_visits, silver_min_visits, gold_min_visits } = body;
    const supplied = { bronze_min_visits, silver_min_visits, gold_min_visits };
    const next = {};
    for (const [key, value] of Object.entries(supplied)) {
      if (value === undefined) continue;
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number <= 0) {
        return res.status(400).json({ error: `${key} must be a positive integer` });
      }
      next[key] = number;
    }
    if (!Object.keys(next).length) return res.status(400).json({ error: 'No fields to update' });
    const { data: current, error: readError } = await db.from('client_rank_settings')
      .select('bronze_min_visits, silver_min_visits, gold_min_visits').eq('id', 1).maybeSingle();
    if (readError) return res.status(500).json({ error: readError.message });
    const effective = { ...LEGACY_RANK_DEFAULTS, ...(current || {}), ...next };
    if (!(effective.silver_min_visits > effective.bronze_min_visits)) {
      return res.status(400).json({ error: 'silver_min_visits must be > bronze_min_visits' });
    }
    if (!(effective.gold_min_visits > effective.silver_min_visits)) {
      return res.status(400).json({ error: 'gold_min_visits must be > silver_min_visits' });
    }
    const { data, error } = await db.from('client_rank_settings').upsert({ id: 1, ...next }, { onConflict: 'id' })
      .select('id, bronze_min_visits, silver_min_visits, gold_min_visits, updated_at').eq('id', 1).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ settings: data });
  }
}

module.exports = new Loyalty();
