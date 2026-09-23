const parsePercent = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 100);
};

const resolveLoyaltyCashbackPercent = (statusPoints, settings, fallback = 0) => {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return parsePercent(fallback);
  }
  const points = Math.max(0, Number(statusPoints) || 0);
  const levels = Object.values(settings)
    .filter((level) => level && typeof level === 'object')
    .map((level) => ({
      minPoints: Math.max(0, Number(level.min_points) || 0),
      cashbackPercent: parsePercent(level.cashback_percent),
    }))
    .sort((left, right) => left.minPoints - right.minPoints);
  const current = levels.filter((level) => points >= level.minPoints).at(-1);
  return current ? current.cashbackPercent : parsePercent(fallback);
};

module.exports = { parsePercent, resolveLoyaltyCashbackPercent };
