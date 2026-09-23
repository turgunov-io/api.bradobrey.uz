const test = require('node:test');
const assert = require('node:assert/strict');

const { isMarketingNotification, isQuietHoursAt } = require('../src/utils/marketplacePushPolicy');

test('marketplace push quiet hours use Asia/Tashkent local time', () => {
  assert.equal(isQuietHoursAt(new Date('2026-01-15T02:59:00.000Z')), true); // 07:59 local
  assert.equal(isQuietHoursAt(new Date('2026-01-15T03:00:00.000Z')), false); // 08:00 local
  assert.equal(isQuietHoursAt(new Date('2026-01-15T16:59:00.000Z')), false); // 21:59 local
  assert.equal(isQuietHoursAt(new Date('2026-01-15T17:00:00.000Z')), true); // 22:00 local
  assert.equal(isMarketingNotification('REFERRAL_EXPIRING'), true);
  assert.equal(isMarketingNotification('SERVICE_COMPLETED'), false);
});
