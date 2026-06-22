#!/usr/bin/env node

require('dotenv').config();

const { db } = require('../src/config/postgres');
const { awardCashbackForCompletedQueueEntry } = require('../src/composable/cashback');

const getArgValue = (name) => {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
};

const hasFlag = (name) => process.argv.includes(name);

const since = getArgValue('--since'); // ISO string (e.g. 2026-01-01 or 2026-01-01T00:00:00Z)
const until = getArgValue('--until'); // ISO string
const batchSize = Math.max(1, Number(getArgValue('--batch') || 100));
const maxRows = Math.max(0, Number(getArgValue('--max') || 0));
const verbose = hasFlag('--verbose');

async function main() {
  if (!process.env.CASHBACK_PERCENT) {
    console.warn('CASHBACK_PERCENT is not set. Backfill will not award anything.');
  }

  let offset = 0;
  let processed = 0;
  let awarded = 0;
  let totalEarned = 0;

  while (true) {
    let query = db
      .from('queue_entries')
      .select('id, client_id, service_id, service_ids, payment_method, certificate_id, finished_at')
      .eq('status', 'completed')
      .order('finished_at', { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (since) query = query.gte('finished_at', since);
    if (until) query = query.lte('finished_at', until);

    const { data, error } = await query;
    if (error) throw error;

    const entries = data || [];
    if (entries.length === 0) break;

    for (const entry of entries) {
      processed += 1;
      const res = await awardCashbackForCompletedQueueEntry(entry);
      if (res?.awarded) {
        awarded += 1;
        totalEarned += Number(res.earned || 0);
      }

      if (verbose) {
        console.log(
          JSON.stringify(
            {
              id: entry.id,
              awarded: Boolean(res?.awarded),
              earned: res?.earned ?? 0,
              balance: res?.balance ?? null,
            },
            null,
            2
          )
        );
      }

      if (maxRows && processed >= maxRows) break;
    }

    if (maxRows && processed >= maxRows) break;
    offset += batchSize;
  }

  console.log(
    JSON.stringify(
      {
        processed,
        awarded,
        total_earned: Number(totalEarned.toFixed(2)),
        since: since || null,
        until: until || null,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

