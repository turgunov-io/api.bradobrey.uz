const PUSH_TIMEZONE = 'Asia/Tashkent';
const MARKETING_TYPES = new Set(['PROMO_FROM_SHOP', 'REFERRAL_EXPIRING']);

const isQuietHoursAt = (date = new Date()) => {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: PUSH_TIMEZONE,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(date));
  return hour >= 22 || hour < 8;
};

const isMarketingNotification = (type) => MARKETING_TYPES.has(String(type || '').trim());

module.exports = { isMarketingNotification, isQuietHoursAt };
