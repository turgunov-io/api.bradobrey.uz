const { pool } = require('../config/postgres');

const DEFAULTS = {
  enabled: true,
  automatic: true,
  first_violation_minutes: 24 * 60,
  second_violation_minutes: 72 * 60,
  third_plus_violation_minutes: 7 * 24 * 60,
  lookback_days: 365,
};

async function registerConfirmedNoShow(queueEntryId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const settingResult = await client.query(
      "select value from platform_settings where key = 'no_show_restrictions'",
    );
    const settings = { ...DEFAULTS, ...(settingResult.rows[0]?.value || {}) };
    const entryResult = await client.query(
      `select q.id, q.client_id, q.status, mc.id as marketplace_client_id
         from queue_entries q
         left join marketplace_booking_persons bp on bp.queue_entry_id = q.id
         left join marketplace_bookings mb on mb.id = bp.booking_id
         left join marketplace_clients mc on mc.id = mb.marketplace_client_id
        where q.id = $1
        limit 1`,
      [queueEntryId],
    );
    const entry = entryResult.rows[0];
    if (!entry || entry.status !== 'no_show') {
      await client.query('ROLLBACK');
      return null;
    }

    let marketplaceClientId = entry.marketplace_client_id;
    if (!marketplaceClientId && entry.client_id) {
      const fallback = await client.query(
        `select mc.id as marketplace_client_id
           from clients c join marketplace_clients mc on regexp_replace(coalesce(mc.phone, ''), '[^0-9]', '', 'g') = regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')
          where c.id = $1 and coalesce(mc.phone, '') <> '' limit 1`,
        [entry.client_id],
      );
      marketplaceClientId = fallback.rows[0]?.marketplace_client_id;
    }
    if (!marketplaceClientId) {
      await client.query('ROLLBACK');
      return null;
    }

    const inserted = await client.query(
      `insert into marketplace_no_show_violations (queue_entry_id, marketplace_client_id, reason)
       values ($1, $2, 'NO_SHOW') on conflict (queue_entry_id) do nothing
       returning id`,
      [queueEntryId, marketplaceClientId],
    );
    if (!inserted.rows[0]) {
      const current = await client.query(
        'select id, blocked_until from marketplace_clients where id = $1',
        [marketplaceClientId],
      );
      await client.query('COMMIT');
      return current.rows[0] || null;
    }

    const clientResult = await client.query(
      'select id, blocked_until from marketplace_clients where id = $1 for update',
      [marketplaceClientId],
    );
    const violationCountResult = await client.query(
      `select count(*)::int as count from marketplace_no_show_violations
        where marketplace_client_id = $1 and created_at >= now() - ($2::int * interval '1 day')`,
      [marketplaceClientId, Number(settings.lookback_days)],
    );
    const violationCount = Number(violationCountResult.rows[0]?.count || 0);
    let blockedUntil = clientResult.rows[0]?.blocked_until || null;
    if (settings.enabled && settings.automatic) {
      const duration = violationCount === 1
        ? Number(settings.first_violation_minutes)
        : violationCount === 2
          ? Number(settings.second_violation_minutes)
          : Number(settings.third_plus_violation_minutes);
      blockedUntil = new Date(Date.now() + duration * 60 * 1000);
      await client.query(
        'update marketplace_clients set blocked_until = $1, no_show_streak = $2 where id = $3',
        [blockedUntil, violationCount, marketplaceClientId],
      );
      await client.query(
        `insert into marketplace_notifications (marketplace_client_id, type, payload)
         values ($1, 'ACCOUNT_BLOCKED', $2::jsonb)`,
        [marketplaceClientId, JSON.stringify({ blocked_until: blockedUntil.toISOString(), reason: 'NO_SHOW', violation_level: Math.min(violationCount, 3) })],
      );
    }
    await client.query('COMMIT');
    return { id: marketplaceClientId, blocked_until: blockedUntil, violation_count: violationCount };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    // The feature migration is additive. A not-yet-migrated database must not
    // prevent an authorized employee from recording a no-show.
    if (error?.code === '42P01' || error?.code === '42703') return null;
    throw error;
  } finally {
    client.release();
  }
}

async function registerConfirmedNoShows(queueEntryIds) {
  const ids = Array.from(new Set((Array.isArray(queueEntryIds) ? queueEntryIds : []).filter(Boolean)));
  const results = [];
  for (const queueEntryId of ids) {
    results.push(await registerConfirmedNoShow(queueEntryId));
  }
  return results;
}

module.exports = { registerConfirmedNoShow, registerConfirmedNoShows, DEFAULTS };
