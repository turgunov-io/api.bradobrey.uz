const DEFAULT_LOYALTY_LEVELS = Object.freeze({
  NONE: Object.freeze({ min_points: 0, cashback_percent: 0, cancel_penalty_points: 10, no_show_penalty_points: 30 }),
  BRONZE: Object.freeze({ min_points: 100, cashback_percent: 1, cancel_penalty_points: 10, no_show_penalty_points: 30 }),
  SILVER: Object.freeze({ min_points: 300, cashback_percent: 2, cancel_penalty_points: 10, no_show_penalty_points: 30 }),
  GOLD: Object.freeze({ min_points: 1500, cashback_percent: 2.5, cancel_penalty_points: 10, no_show_penalty_points: 30 }),
});

function validateLoyaltyLevels(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'levels must be a non-empty object' };
  }
  const entries = Object.entries(input);
  if (!entries.length) return { error: 'levels must be a non-empty object' };

  const names = new Set();
  const levels = [];
  for (const [rawName, value] of entries) {
    const name = String(rawName).trim();
    if (!name || name.length > 40 || !/^[\p{L}\p{N}_ -]+$/u.test(name)) {
      return { error: `Invalid rank name: ${rawName}` };
    }
    const nameKey = name.toLocaleLowerCase();
    if (names.has(nameKey)) return { error: 'Rank names must be unique' };
    names.add(nameKey);
    const min = value?.min_points;
    const cashback = value?.cashback_percent ?? 0;
    if (!Number.isSafeInteger(min) || min < 0) {
      return { error: `${name}.min_points must be a non-negative integer` };
    }
    if (typeof cashback !== 'number' || !Number.isFinite(cashback) || cashback < 0 || cashback > 100) {
      return { error: `${name}.cashback_percent must be between 0 and 100` };
    }
    const cancelPenalty = value?.cancel_penalty_points ?? 10;
    const noShowPenalty = value?.no_show_penalty_points ?? 30;
    for (const [field, penalty] of [['cancel_penalty_points', cancelPenalty], ['no_show_penalty_points', noShowPenalty]]) {
      if (!Number.isSafeInteger(penalty) || penalty < 0) {
        return { error: `${name}.${field} must be a non-negative integer` };
      }
    }
    levels.push({ name, min_points: min, cashback_percent: cashback, cancel_penalty_points: cancelPenalty, no_show_penalty_points: noShowPenalty });
  }

  levels.sort((a, b) => a.min_points - b.min_points);
  if (levels[0].min_points !== 0) return { error: 'The first rank must start at 0 points' };
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i].min_points <= levels[i - 1].min_points) {
      return { error: 'Each rank must start above the previous rank threshold' };
    }
  }

  return {
    value: Object.fromEntries(levels.map(({ name, min_points, cashback_percent, cancel_penalty_points, no_show_penalty_points }) => [
      name,
      { min_points, cashback_percent, cancel_penalty_points, no_show_penalty_points },
    ])),
  };
}

function resolveLoyaltyLevel(points, settings) {
  const value = Number.isFinite(Number(points)) ? Math.max(0, Number(points)) : 0;
  const levels = Object.entries(settings && typeof settings === 'object' ? settings : DEFAULT_LOYALTY_LEVELS)
    .map(([name, config]) => ({
      name,
      min_points: Number(config?.min_points) || 0,
      cashback_percent: Number(config?.cashback_percent) || 0,
      cancel_penalty_points: Number(config?.cancel_penalty_points) || 0,
      no_show_penalty_points: Number(config?.no_show_penalty_points) || 0,
    }))
    .sort((a, b) => a.min_points - b.min_points);
  const current = levels.filter((level) => value >= level.min_points).at(-1) || levels[0];
  return current || { name: 'NONE', min_points: 0, cashback_percent: 0 };
}

module.exports = { DEFAULT_LOYALTY_LEVELS, resolveLoyaltyLevel, validateLoyaltyLevels };
