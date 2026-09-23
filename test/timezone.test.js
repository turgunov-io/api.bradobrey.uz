const test = require('node:test');
const assert = require('node:assert/strict');

const {
  nextZonedDayStartIso,
  zonedDayStartIso,
  zonedDateString,
} = require('../src/utils/timezone');

test('timezone helpers calculate booking day boundaries in the branch timezone', () => {
  const instant = new Date('2026-01-15T12:00:00.000Z');

  assert.equal(zonedDateString(instant, 'Asia/Tashkent'), '2026-01-15');
  assert.equal(zonedDayStartIso(instant, 'Asia/Tashkent'), '2026-01-14T19:00:00.000Z');
  assert.equal(nextZonedDayStartIso(instant, 'Asia/Tashkent'), '2026-01-15T19:00:00.000Z');

  assert.equal(zonedDayStartIso(instant, 'America/New_York'), '2026-01-15T05:00:00.000Z');
  assert.equal(nextZonedDayStartIso(instant, 'America/New_York'), '2026-01-16T05:00:00.000Z');
});
