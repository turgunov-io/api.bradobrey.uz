const { supabase } = require('../config/supabase');

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

const normalizeTimeZone = (value) => {
    const timeZone = String(value || '').trim() || DEFAULT_TIMEZONE;

    try {
        getFormatter(timeZone).format(new Date());
        return timeZone;
    } catch (_error) {
        console.warn(`[queue-auto-close] Invalid timezone "${timeZone}", falling back to ${DEFAULT_TIMEZONE}`);
        return DEFAULT_TIMEZONE;
    }
};

async function closePreviousDayOpenQueueEntries({ io = null, now = new Date(), timeZone } = {}) {
    const normalizedTimeZone = normalizeTimeZone(timeZone || process.env.QUEUE_AUTO_CLOSE_TIMEZONE || process.env.TZ);
    const cutoffIso = getLocalDayStartUtc(now, normalizedTimeZone).toISOString();
    const finishedAt = now.toISOString();

    const { data, error } = await supabase
        .from('queue_entries')
        .update({
            finished_at: finishedAt,
            status: 'no_show',
        })
        .lt('created_at', cutoffIso)
        .in('status', OPEN_NO_SHOW_STATUSES)
        .select('id, branch_id, barber_id, status');

    if (error) {
        throw new Error(error.message);
    }

    const rows = Array.isArray(data) ? data : [];
    const branchIds = Array.from(new Set(rows.map((row) => row.branch_id).filter(Boolean)));

    if (io) {
        for (const branchId of branchIds) {
            io.to(`branch:${branchId}`).emit('queue:update', {
                type: 'queue_auto_closed',
                branchId,
                count: rows.filter((row) => row.branch_id === branchId).length,
            });
        }
    }

    return {
        closed_count: rows.length,
        cutoff: cutoffIso,
        status: 'ok',
        timeZone: normalizedTimeZone,
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

    const scheduleNext = () => {
        const now = new Date();
        const nextMidnight = getNextLocalMidnightUtc(now, timeZone);
        const delayMs = Math.max(1000, nextMidnight.getTime() - now.getTime());

        schedulerTimer = setTimeout(async () => {
            await run('scheduled midnight cleanup');
            scheduleNext();
        }, delayMs);

        if (typeof schedulerTimer.unref === 'function') {
            schedulerTimer.unref();
        }

        console.log(`[queue-auto-close] Next cleanup at ${nextMidnight.toISOString()} (${timeZone} midnight)`);
    };

    if (String(process.env.QUEUE_AUTO_CLOSE_ON_STARTUP || 'true').toLowerCase() !== 'false') {
        run('startup cleanup');
    }

    scheduleNext();

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
    startQueueAutoCloseScheduler,
    stopQueueAutoCloseScheduler,
};
