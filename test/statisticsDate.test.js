const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeOptionalDateRange,
  normalizeStatisticsDateRange,
  toTashkentDateKey,
} = require('../src/utils/statisticsDate');

test('statistics date ranges use Tashkent half-open calendar days', () => {
  assert.deepEqual(normalizeStatisticsDateRange('2026-10-19', '2026-10-19'), {
    endDate: '2026-10-19',
    endExclusive: '2026-10-20T00:00:00+05:00',
    startDate: '2026-10-19',
    startInclusive: '2026-10-19T00:00:00+05:00',
  });
  assert.match(normalizeStatisticsDateRange('2026-10-20', '2026-10-19').error, /earlier/);
  assert.match(normalizeStatisticsDateRange('2026-02-30', '2026-03-01').error, /valid/);
});

test('history keeps one-sided date filters compatible and rejects reversed bounds', () => {
  assert.deepEqual(normalizeOptionalDateRange('2026-10-19', null), {
    endExclusive: null,
    startInclusive: '2026-10-19T00:00:00+05:00',
  });
  assert.deepEqual(normalizeOptionalDateRange(null, '2026-10-19'), {
    endExclusive: '2026-10-20T00:00:00+05:00',
    startInclusive: null,
  });
  assert.match(normalizeOptionalDateRange('2026-10-20', '2026-10-19').error, /earlier/);
});

test('statistics daily buckets use the branch timezone at UTC day boundaries', () => {
  assert.equal(toTashkentDateKey('2026-10-18T19:00:00.000Z'), '2026-10-19');
  assert.equal(toTashkentDateKey('2026-10-19T18:59:59.999Z'), '2026-10-19');
  assert.equal(toTashkentDateKey('2026-10-19T19:00:00.000Z'), '2026-10-20');
});
