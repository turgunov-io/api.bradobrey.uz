const { db } = require('../config/postgres');
const { registerConfirmedNoShows } = require('../services/marketplaceNoShowRestriction');

const DEFAULT_TIMEZONE = 'Asia/Tashkent';
const OPEN_NO_SHOW_STATUSES = ['waiting', 'called', 'swapped'];

let schedulerTimer = null;
let schedulerStarted = false;
let schedulerRunning = false;

const getFormatter = (timeZone) => new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
});

const getTimeZoneParts = (date, timeZone) => {
    const parts = getFormatter(timeZone).formatToParts(date);
    const values = {};

    for (const part of parts) {
        if (part.type !== 'literal') {
            values[part.type] = Number(part.value);
        }
    }

    return values;
};

const getTimeZoneOffsetMs = (date, timeZone) => {
    const parts = getTimeZoneParts(date, timeZone);
    const utcTime = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
    );

    return utcTime - date.getTime();
};

const zonedDateTimeToUtc = ({ day, hour = 0, minute = 0, month, second = 0, year }, timeZone) => {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
    const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);

    return new Date(utcGuess - offset);
};

const getLocalDayStartUtc = (date, timeZone) => {
    const parts = getTimeZoneParts(date, timeZone);

    return zonedDateTimeToUtc({
        day: parts.day,
        month: parts.month,
        year: parts.year,
    }, timeZone);
};

const getNextLocalMidnightUtc = (date, timeZone) => {
    const parts = getTimeZoneParts(date, timeZone);

    return zonedDateTimeToUtc({
        day: parts.day + 1,
        month: parts.month,
        year: parts.year,
    }, timeZone);
};

const isValidTimeZone = (value) => {
    try {
        getFormatter(value).format(new Date());
        return true;
    } catch (_error) {
        return false;
    }
};

const normalizeTimeZone = (value, fallback = DEFAULT_TIMEZONE) => {
    const timeZone = String(value || '').trim() || fallback;
    if (isValidTimeZone(timeZone)) return timeZone;
    console.warn(`[queue-auto-close] Invalid timezone "${timeZone}", falling back to ${fallback}`);
    return isValidTimeZone(fallback) ? fallback : DEFAULT_TIMEZONE;
};

// MULTI_TENANCY B2: every company (and every branch) closes the previous day
// at ITS local midnight. Effective timezone: branch.timezone, else
// companies.timezone, else the process fallback. Pure: groups the targets by
// timezone so one UPDATE per timezone covers all companies/branches in it.
//   branches:  [{ id, timezone, company_timezone }]
//   companies: [{ id, timezone }]   (for queue entries without a branch)
// -> Map<timezone, { branchIds: string[], companyIds: string[] }>
function groupTargetsByTimezone({ branches = [], companies = [], fallbackTimeZone = DEFAULT_TIMEZONE } = {}) {
    const groups = new Map();
    const group = (timeZone) => {
        if (!groups.has(timeZone)) groups.set(timeZone, { branchIds: [], companyIds: [] });
        return groups.get(timeZone);
    };
    for (const branch of branches) {
        const timeZone = normalizeTimeZone(branch.timezone, normalizeTimeZone(branch.company_timezone, fallbackTimeZone));
        group(timeZone).branchIds.push(String(branch.id));
    }
    for (const company of companies) {
        group(normalizeTimeZone(company.timezone, fallbackTimeZone)).companyIds.push(String(company.id));
    }
    return groups;
}

const CLOSE_SQL = `
    update queue_entries
       set finished_at = $1, status = 'no_show'
     where created_at < $2
       and status = any($3::text[])
       and (
         branch_id = any($4::uuid[])
         or (branch_id is null and company_id = any($5::uuid[]))
       )
    returning id, branch_id, barber_id, status, company_id`;

async function loadCloseTargets() {
    const [branches, companies] = await Promise.all([
        db.query(`select b.id, b.timezone, c.timezone as company_timezone
                   from branches b
                   join companies c on c.id = b.company_id`),
        db.query('select id, timezone from companies'),
    ]);
    return { branches: branches.rows || [], companies: companies.rows || [] };
}

async function closePreviousDayOpenQueueEntries({ io = null, now = new Date(), timeZone, loadTargets = loadCloseTargets } = {}) {
    const fallbackTimeZone = normalizeTimeZone(timeZone || process.env.QUEUE_AUTO_CLOSE_TIMEZONE || process.env.TZ);
    const finishedAt = now.toISOString();
    const targets = await loadTargets();
    const groups = groupTargetsByTimezone({ ...targets, fallbackTimeZone });

    const rows = [];
    const cutoffs = {};
    for (const [groupTimeZone, { branchIds, companyIds }] of groups) {
        const cutoffIso = getLocalDayStartUtc(now, groupTimeZone).toISOString();
        cutoffs[groupTimeZone] = cutoffIso;
        const result = await db.query(CLOSE_SQL, [finishedAt, cutoffIso, OPEN_NO_SHOW_STATUSES, branchIds, companyIds]);
        rows.push(...(result.rows || []));
    }

    await registerConfirmedNoShows(rows.map((row) => row.id));
    const branchIds = Array.from(new Set(rows.map((row) => row.branch_id).filter(Boolean)));

    if (io) {
        for (const branchId of branchIds) {
            const branchRows = rows.filter((row) => row.branch_id === branchId);
            const room = io.to(`branch:${branchId}`);
            room.emit('queue:update', {
                type: 'queue_auto_closed',
                branchId,
                count: branchRows.length,
            });
            for (const row of branchRows) {
                room.emit('queue.no_show', {
                    type: 'no_show',
                    branchId,
                    entryId: row.id,
                    barberId: row.barber_id,
                    status: row.status,
                });
            }
        }
    }

    return {
        closed_count: rows.length,
        cutoff: cutoffs[fallbackTimeZone] || Object.values(cutoffs)[0] || null,
        cutoffs,
        status: 'ok',
        timeZone: fallbackTimeZone,
    };
}

function startQueueAutoCloseScheduler({ io = null } = {}) {
    if (schedulerStarted) {
        return {
            stop: stopQueueAutoCloseScheduler,
        };
    }

    if (String(process.env.QUEUE_AUTO_CLOSE_ENABLED || 'true').toLowerCase() === 'false') {
        console.log('[queue-auto-close] Scheduler disabled by QUEUE_AUTO_CLOSE_ENABLED=false');
        return {
            stop: stopQueueAutoCloseScheduler,
        };
    }

    schedulerStarted = true;
    const timeZone = normalizeTimeZone(process.env.QUEUE_AUTO_CLOSE_TIMEZONE || process.env.TZ);

    const run = async (reason) => {
        if (schedulerRunning) return;
        schedulerRunning = true;

        try {
            const result = await closePreviousDayOpenQueueEntries({ io, timeZone });
            console.log(`[queue-auto-close] ${reason}: closed=${result.closed_count}, cutoff=${result.cutoff}, timezone=${result.timeZone}`);
        } catch (error) {
            console.error(`[queue-auto-close] ${reason} failed:`, error.message);
        } finally {
            schedulerRunning = false;
        }
    };

    // Companies/branches may use different timezones, so wake at the earliest
    // next local midnight among them (re-read every cycle; the default
    // timezone is always included). Running for an already-closed timezone is
    // a no-op, so an early wake-up is harmless.
    const nextWakeUp = async (now) => {
        let zones = [timeZone];
        try {
            const targets = await loadCloseTargets();
            zones = [...groupTargetsByTimezone({ ...targets, fallbackTimeZone: timeZone }).keys(), timeZone];
        } catch (error) {
            console.error('[queue-auto-close] timezone lookup failed:', error.message);
        }
        return zones
            .map((zone) => getNextLocalMidnightUtc(now, zone))
            .reduce((earliest, candidate) => (candidate < earliest ? candidate : earliest));
    };

    const scheduleNext = async () => {
        const now = new Date();
        const nextMidnight = await nextWakeUp(now);
        const delayMs = Math.max(1000, nextMidnight.getTime() - now.getTime());

        schedulerTimer = setTimeout(async () => {
            await run('scheduled midnight cleanup');
            scheduleNext();
        }, delayMs);

        if (typeof schedulerTimer.unref === 'function') {
            schedulerTimer.unref();
        }

        console.log(`[queue-auto-close] Next cleanup at ${nextMidnight.toISOString()} (earliest local midnight)`);
    };

    if (String(process.env.QUEUE_AUTO_CLOSE_ON_STARTUP || 'true').toLowerCase() !== 'false') {
        run('startup cleanup');
    }

    void scheduleNext();

    return {
        stop: stopQueueAutoCloseScheduler,
    };
}

function stopQueueAutoCloseScheduler() {
    if (schedulerTimer) {
        clearTimeout(schedulerTimer);
        schedulerTimer = null;
    }

    schedulerStarted = false;
    schedulerRunning = false;
}

module.exports = {
    closePreviousDayOpenQueueEntries,
    groupTargetsByTimezone,
    getLocalDayStartUtc,
    startQueueAutoCloseScheduler,
    stopQueueAutoCloseScheduler,
};
