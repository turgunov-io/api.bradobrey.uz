const ACTIVE_QUEUE_STATUSES = new Set(['waiting', 'called', 'swapped', 'in_progress']);
const MIN_ACTIVE_BLOCKING_MINUTES = 1;

function serviceIdsForQueueEntry(entry = {}) {
  if (Array.isArray(entry.service_ids) && entry.service_ids.length) {
    return entry.service_ids.filter(Boolean);
  }
  return entry.service_id ? [entry.service_id] : [];
}

function durationForService(durationByServiceId, serviceId) {
  const key = String(serviceId);
  const value = durationByServiceId instanceof Map
    ? durationByServiceId.get(key)
    : durationByServiceId?.[key];
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function plannedDurationForEntry(entry, durationByServiceId) {
  return serviceIdsForQueueEntry(entry).reduce((sum, serviceId) => (
    sum + durationForService(durationByServiceId, serviceId)
  ), 0);
}

function queueEntryTiming(entry, durationByServiceId, now = Date.now(), plannedMinutesOverride = null) {
  const hasOverride = plannedMinutesOverride !== null && plannedMinutesOverride !== undefined;
  const plannedMinutes = hasOverride && Number.isFinite(Number(plannedMinutesOverride))
    ? Math.max(0, Number(plannedMinutesOverride))
    : plannedDurationForEntry(entry, durationByServiceId);
  const startedAt = entry?.started_at ? new Date(entry.started_at).getTime() : NaN;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const hasStartedAt = Number.isFinite(startedAt) && Number.isFinite(nowMs);
  const elapsedMinutes = entry?.status === 'in_progress' && hasStartedAt
    ? Math.max(0, (nowMs - startedAt) / 60_000)
    : 0;
  const remainingMinutes = entry?.status === 'in_progress'
    ? Math.max(0, plannedMinutes - elapsedMinutes)
    : plannedMinutes;
  const isActive = ACTIVE_QUEUE_STATUSES.has(entry?.status);

  return {
    blockingMinutes: isActive && entry?.status === 'in_progress'
      ? Math.max(MIN_ACTIVE_BLOCKING_MINUTES, Math.ceil(remainingMinutes))
      : plannedMinutes,
    elapsedMinutes,
    overdue: entry?.status === 'in_progress' && hasStartedAt && elapsedMinutes >= plannedMinutes,
    plannedMinutes,
    remainingMinutes: Math.ceil(remainingMinutes),
  };
}

module.exports = {
  MIN_ACTIVE_BLOCKING_MINUTES,
  plannedDurationForEntry,
  queueEntryTiming,
  serviceIdsForQueueEntry,
};
