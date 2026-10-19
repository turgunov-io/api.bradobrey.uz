const test = require('node:test');
const assert = require('node:assert/strict');

// The copy helper is pure, but the push module also wires the shared pool.
// Provide non-connecting test configuration so this unit test stays offline.
process.env.PGHOST ||= '127.0.0.1';
process.env.PGPORT ||= '5432';
process.env.PGDATABASE ||= 'test';
process.env.PGUSER ||= 'test';
process.env.PGPASSWORD ||= 'test';

const { isMarketingNotification, isQuietHoursAt } = require('../src/utils/marketplacePushPolicy');
const { getNotificationCopy } = require('../src/services/marketplacePush');

test('marketplace push quiet hours use Asia/Tashkent local time', () => {
  assert.equal(isQuietHoursAt(new Date('2026-01-15T02:59:00.000Z')), true); // 07:59 local
  assert.equal(isQuietHoursAt(new Date('2026-01-15T03:00:00.000Z')), false); // 08:00 local
  assert.equal(isQuietHoursAt(new Date('2026-01-15T16:59:00.000Z')), false); // 21:59 local
  assert.equal(isQuietHoursAt(new Date('2026-01-15T17:00:00.000Z')), true); // 22:00 local
  assert.equal(isMarketingNotification('REFERRAL_EXPIRING'), true);
  assert.equal(isMarketingNotification('SERVICE_COMPLETED'), false);
});

test('marketplace push copy follows the client language and has a safe fallback', () => {
  assert.deepEqual(getNotificationCopy('BOOKING_CREATED', 'ru'), {
    title: 'Бронирование создано',
    body: 'Вы добавлены в живую очередь.',
  });
  assert.deepEqual(getNotificationCopy('BOOKING_CREATED', 'uz-UZ'), {
    title: 'Yozilish yaratildi',
    body: "Siz jonli navbatga qo'shildingiz.",
  });
  assert.deepEqual(getNotificationCopy('BOOKING_CREATED', 'en'), {
    title: 'Booking created',
    body: 'You have been added to the live queue.',
  });
  assert.deepEqual(getNotificationCopy('UNKNOWN_EVENT', 'de'), {
    title: 'BRADOBREY',
    body: 'У вас новое уведомление.',
  });
});
