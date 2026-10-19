const { pool } = require('../config/postgres');
const { isMarketingNotification, isQuietHoursAt } = require('../utils/marketplacePushPolicy');
const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const PUSH_NOTIFY_CHANNEL = 'marketplace_notification_created';
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.MARKETPLACE_PUSH_POLL_MS || 2000));

const notificationCopy = {
  ru: {
    BOOKING_CREATED: ['Бронирование создано', 'Вы добавлены в живую очередь.'],
    BOOKING_CANCELLED: ['Бронирование отменено', 'Ваше бронирование отменено.'],
    REFERRAL_BONUS: ['Начислен реферальный бонус', 'Ваш бонус за приглашение доступен в профиле.'],
    LEVEL_CHANGED: ['Изменился уровень лояльности', 'Проверьте новый уровень и доступные привилегии.'],
    ACCOUNT_BLOCKED: ['Аккаунт временно ограничен', 'Откройте приложение, чтобы узнать подробности.'],
    ACCOUNT_BLOCKED_CANCELS: ['Аккаунт временно ограничен', 'Лимит отмен за сегодня превышен. Проверьте подробности в приложении.'],
    NO_SHOW: ['Неявка зафиксирована', 'Баллы статуса изменены. Проверьте подробности в профиле.'],
    NO_SHOW_PENALTY: ['Неявка зафиксирована', 'Баллы статуса изменены. Проверьте подробности в профиле.'],
    YOU_ARE_CALLED: ['Вас вызывают', 'Подойдите к выбранному барберу.'],
    SERVICE_STARTED: ['Услуга началась', 'Барбер начал обслуживание.'],
    SERVICE_COMPLETED: ['Услуга завершена', 'Спасибо за визит. Оцените обслуживание в приложении.'],
    REFERRAL_EXPIRING: ['Реферальный бонус скоро истечёт', 'У вас осталось 30 дней, чтобы воспользоваться реферальной возможностью.'],
    QUEUE_POSITION_CHANGED: ['Изменилась позиция в очереди', 'Откройте приложение, чтобы увидеть актуальное ожидание.'],
    ALMOST_YOUR_TURN: ['Скоро ваша очередь', 'Пожалуйста, будьте готовы подойти к барберу.'],
    BARBER_READY: ['Барбер готов', 'Ваш барбер готов принять вас.'],
    CASHBACK_EARNED: ['Начислен кешбек', 'Кешбек за завершённую услугу доступен в кошельке.'],
    PROMO_FROM_SHOP: ['Новое предложение', 'В выбранном барбершопе появилось новое предложение.'],
    TEST_NOTIFICATION: ['Тестовое уведомление', 'Это тестовое уведомление Bradobrey.'],
    DEFAULT: ['BRADOBREY', 'У вас новое уведомление.'],
  },
  uz: {
    BOOKING_CREATED: ['Yozilish yaratildi', 'Siz jonli navbatga qo\'shildingiz.'],
    BOOKING_CANCELLED: ['Yozilish bekor qilindi', 'Yozilishingiz bekor qilindi.'],
    REFERRAL_BONUS: ['Referal bonusi qo\'shildi', 'Taklif bonusingiz profilda mavjud.'],
    LEVEL_CHANGED: ['Loyallik darajasi o\'zgardi', 'Yangi daraja va imtiyozlaringizni tekshiring.'],
    ACCOUNT_BLOCKED: ['Hisob vaqtincha cheklangan', 'Tafsilotlarni bilish uchun ilovani oching.'],
    ACCOUNT_BLOCKED_CANCELS: ['Hisob vaqtincha cheklangan', 'Bugungi bekor qilish limiti oshib ketdi. Tafsilotlarni ilovada ko\'ring.'],
    NO_SHOW: ['Kelmaganlik qayd etildi', 'Status ballari o\'zgardi. Tafsilotlarni profilda ko\'ring.'],
    NO_SHOW_PENALTY: ['Kelmaganlik qayd etildi', 'Status ballari o\'zgardi. Tafsilotlarni profilda ko\'ring.'],
    YOU_ARE_CALLED: ['Sizni chaqirishmoqda', 'Tanlangan barber yoniga boring.'],
    SERVICE_STARTED: ['Xizmat boshlandi', 'Barber sizga xizmat ko\'rsatishni boshladi.'],
    SERVICE_COMPLETED: ['Xizmat yakunlandi', 'Tashrifingiz uchun rahmat. Xizmatni baholang.'],
    REFERRAL_EXPIRING: ['Referal bonusi tez orada tugaydi', 'Referal imkoniyatidan foydalanish uchun 30 kun qoldi.'],
    QUEUE_POSITION_CHANGED: ['Navbatdagi o\'rningiz o\'zgardi', 'Joriy kutish vaqtini ilovada ko\'ring.'],
    ALMOST_YOUR_TURN: ['Navbatingiz yaqin', 'Barber yoniga borishga tayyor bo\'ling.'],
    BARBER_READY: ['Barber tayyor', 'Barberingiz sizni qabul qilishga tayyor.'],
    CASHBACK_EARNED: ['Keshbek qo\'shildi', 'Yakunlangan xizmat uchun keshbek hamyonda mavjud.'],
    PROMO_FROM_SHOP: ['Yangi taklif', 'Tanlangan barbershopda yangi taklif paydo bo\'ldi.'],
    TEST_NOTIFICATION: ['Test bildirishnomasi', 'Bu Bradobrey test bildirishnomasi.'],
    DEFAULT: ['BRADOBREY', 'Sizda yangi bildirishnoma bor.'],
  },
  en: {
    BOOKING_CREATED: ['Booking created', 'You have been added to the live queue.'],
    BOOKING_CANCELLED: ['Booking cancelled', 'Your booking has been cancelled.'],
    REFERRAL_BONUS: ['Referral bonus added', 'Your referral bonus is available in your profile.'],
    LEVEL_CHANGED: ['Loyalty level changed', 'Check your new level and available benefits.'],
    ACCOUNT_BLOCKED: ['Account temporarily restricted', 'Open the app for more details.'],
    ACCOUNT_BLOCKED_CANCELS: ['Account temporarily restricted', 'Today\'s cancellation limit was exceeded. Check the app for details.'],
    NO_SHOW: ['No-show recorded', 'Your status points changed. Check your profile for details.'],
    NO_SHOW_PENALTY: ['No-show recorded', 'Your status points changed. Check your profile for details.'],
    YOU_ARE_CALLED: ['You are being called', 'Please go to your selected barber.'],
    SERVICE_STARTED: ['Service started', 'Your barber has started the service.'],
    SERVICE_COMPLETED: ['Service completed', 'Thank you for visiting. Rate your service in the app.'],
    REFERRAL_EXPIRING: ['Referral bonus expiring soon', 'You have 30 days left to use your referral benefit.'],
    QUEUE_POSITION_CHANGED: ['Queue position changed', 'Open the app to see your current wait.'],
    ALMOST_YOUR_TURN: ['Almost your turn', 'Please be ready to go to your barber.'],
    BARBER_READY: ['Barber ready', 'Your barber is ready to serve you.'],
    CASHBACK_EARNED: ['Cashback added', 'Cashback for your completed service is available in your wallet.'],
    PROMO_FROM_SHOP: ['New offer', 'A new offer is available at your selected barbershop.'],
    TEST_NOTIFICATION: ['Test notification', 'This is a Bradobrey test notification.'],
    DEFAULT: ['BRADOBREY', 'You have a new notification.'],
  },
};

const normalizeLanguage = (language) => {
  const value = String(language || '').trim().toLowerCase().split('-')[0];
  return Object.prototype.hasOwnProperty.call(notificationCopy, value) ? value : 'ru';
};

const getNotificationCopy = (type, language) => {
  const localized = notificationCopy[normalizeLanguage(language)];
  const pair = localized[type] || localized.DEFAULT;
  return { title: pair[0], body: pair[1] };
};

const providerUrl = () => String(process.env.MARKETPLACE_PUSH_WEBHOOK_URL || '').trim();

let firebaseMessaging = null;
let firebaseInitializationAttempted = false;
let pushListenerClient = null;

const firebaseServiceAccount = () => {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) return null;
    return {
      projectId: parsed.project_id,
      clientEmail: parsed.client_email,
      privateKey: String(parsed.private_key).replace(/\\n/g, '\n'),
    };
  } catch (_error) {
    console.error('[marketplace-push] Firebase credentials unavailable', { reason: 'invalid_service_account_json' });
    return null;
  }
};

const getFirebaseMessaging = () => {
  if (firebaseMessaging || firebaseInitializationAttempted) return firebaseMessaging;
  firebaseInitializationAttempted = true;
  const serviceAccount = firebaseServiceAccount();
  if (!serviceAccount) return null;

  try {
    const app = getApps()[0] || initializeApp({ credential: cert(serviceAccount) });
    firebaseMessaging = getMessaging(app);
    return firebaseMessaging;
  } catch (error) {
    console.error('[marketplace-push] Firebase initialization failed', {
      reason: String(error?.code || 'initialization_error'),
    });
    return null;
  }
};

async function sendFcmNotification({ token, title, body, data = {}, channelId = 'queue_reminders_v2' }) {
  const messaging = getFirebaseMessaging();
  if (!messaging) return { delivered: false, reason: 'provider_not_configured' };

  await messaging.send({
    token,
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, String(value ?? '')]),
    ),
    android: {
      priority: 'high',
      notification: { channelId, sound: 'default' },
    },
    apns: { payload: { aps: { sound: 'default' } } },
  });
  return { delivered: true };
}

const providerConfigured = () => Boolean(getFirebaseMessaging() || providerUrl());

const sendToProvider = async ({
  token,
  platform,
  type,
  payload,
  notificationId,
  language,
  title: customTitle,
  body: customBody,
}) => {
  const copy = getNotificationCopy(type, language);
  const title = String(customTitle || copy.title).trim();
  const body = String(customBody || copy.body).trim();

  const messaging = getFirebaseMessaging();
  if (messaging) {
    return sendFcmNotification({
      token,
      title,
      body,
      channelId: 'queue_reminders_v2',
      data: {
        type,
        language: normalizeLanguage(language),
        notification_id: notificationId,
        ...(payload || {}),
      },
    });
  }

  const url = providerUrl();
  if (!url || typeof fetch !== 'function') return { delivered: false };

  const headers = { 'content-type': 'application/json' };
  if (process.env.MARKETPLACE_PUSH_WEBHOOK_TOKEN) {
    headers.authorization = `Bearer ${process.env.MARKETPLACE_PUSH_WEBHOOK_TOKEN}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      token,
      platform,
      type,
      language: normalizeLanguage(language),
      title,
      body,
      payload: payload || {},
    }),
  });

  return { delivered: response.ok };
};

async function sendTestNotificationToClient({ clientId, title, body }) {
  if (!providerConfigured()) {
    return { sent: false, reason: 'provider_not_configured', delivered: 0, tokens: 0 };
  }

  const result = await pool.query(
    `select marketplace_client_id, token, platform
       from marketplace_push_tokens
      where marketplace_client_id = $1`,
    [clientId],
  );
  if (!result.rows.length) {
    return { sent: false, reason: 'no_tokens', delivered: 0, tokens: 0 };
  }

  let delivered = 0;
  for (const token of result.rows) {
    try {
      const response = await sendToProvider({
        token: token.token,
        platform: token.platform,
        type: 'TEST_NOTIFICATION',
        payload: { test: 'true' },
        language: 'ru',
        title,
        body,
      });
      if (response.delivered) delivered += 1;
    } catch (error) {
      console.error('[marketplace-push] test delivery failed', error.message);
      if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error.code)) {
        await pool.query(
          'delete from marketplace_push_tokens where marketplace_client_id = $1 and token = $2',
          [clientId, token.token],
        );
      }
    }
  }

  return {
    sent: delivered > 0,
    reason: delivered > 0 ? undefined : 'delivery_failed',
    delivered,
    tokens: result.rows.length,
  };
}

const dispatchNotification = async (notificationId) => {
  if (!providerConfigured()) return { sent: false, reason: 'provider_not_configured' };

  const result = await pool.query(
    `with claimed as (
       update marketplace_notifications
          set push_claimed_at = now(), push_attempts = push_attempts + 1
        where id = $1 and sent_at is null
          and (push_claimed_at is null or push_claimed_at < now() - interval '10 minutes')
        returning id
     )
       select n.id, n.marketplace_client_id, n.type, n.payload,
              coalesce(mc.language, 'ru') as language, t.token, t.platform
       from claimed claim
       join marketplace_notifications n on n.id = claim.id
       left join marketplace_clients mc on mc.id = n.marketplace_client_id
       left join marketplace_push_tokens t
         on t.marketplace_client_id = n.marketplace_client_id`,
    [notificationId]
  );

  if (!result.rows.length) return { sent: false, reason: 'already_sent_or_missing' };

  const notification = result.rows[0];
  if (isMarketingNotification(notification.type) && isQuietHoursAt()) {
    await pool.query('update marketplace_notifications set push_claimed_at = null where id = $1', [notificationId]);
    return { sent: false, reason: 'quiet_hours' };
  }
  const tokens = result.rows.filter((row) => row.token);
  if (!tokens.length) {
    await pool.query('update marketplace_notifications set push_claimed_at = null where id = $1', [notificationId]);
    return { sent: false, reason: 'no_tokens' };
  }

  let delivered = 0;
  for (const token of tokens) {
    try {
      const result = await sendToProvider({
        token: token.token,
        platform: token.platform,
        type: notification.type,
        payload: notification.payload,
        notificationId: notification.id,
        language: notification.language,
      });
      if (result.delivered) delivered += 1;
    } catch (error) {
      console.error('[marketplace-push] delivery failed', error.message);
      if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error.code)) {
        await pool.query(
          'delete from marketplace_push_tokens where marketplace_client_id = $1 and token = $2',
          [notification.marketplace_client_id, token.token],
        );
      }
    }
  }

  if (delivered > 0) {
    await pool.query(
      'update marketplace_notifications set sent_at = coalesce(sent_at, now()), push_claimed_at = null where id = $1',
      [notificationId]
    );
  } else {
    await pool.query('update marketplace_notifications set push_claimed_at = null where id = $1', [notificationId]);
  }

  return { sent: delivered > 0, delivered };
};

const dispatchPending = async () => {
  if (!providerConfigured()) return;

  const result = await pool.query(
    `select id
       from marketplace_notifications
      where sent_at is null
      order by created_at asc
      limit 100`
  );

  for (const row of result.rows) await dispatchNotification(row.id);
};

const startPushNotificationListener = async () => {
  try {
    const client = await pool.connect();
    await client.query(`listen ${PUSH_NOTIFY_CHANNEL}`);
    pushListenerClient = client;
    client.on('notification', (message) => {
      const notificationId = String(message.payload || '').trim();
      if (!notificationId) return;
      void dispatchNotification(notificationId).catch((error) => {
        console.error('[marketplace-push] event dispatch failed', error.message);
      });
    });
    client.on('error', (error) => {
      console.error('[marketplace-push] listener failed; polling fallback remains active:', error.message);
      if (pushListenerClient === client) pushListenerClient = null;
      client.release(error);
    });
  } catch (error) {
    console.error('[marketplace-push] listener unavailable; polling fallback remains active:', error.message);
  }
};

const enqueueReferralExpiryNotifications = async () => {
  await pool.query(
    `insert into marketplace_notifications (marketplace_client_id, type, payload)
     select r.referrer_client_id, 'REFERRAL_EXPIRING', jsonb_build_object(
              'referral_id', r.id,
              'expires_at', r.expires_at
            )
       from referrals r
      where r.expires_at > now() + interval '29 days'
        and r.expires_at <= now() + interval '30 days'
        and not exists (
          select 1 from marketplace_notifications n
           where n.marketplace_client_id = r.referrer_client_id
             and n.type = 'REFERRAL_EXPIRING'
             and n.payload ->> 'referral_id' = r.id::text
        )`
  );
};

const startMarketplaceNotificationDispatcher = () => {
  if (!providerConfigured()) {
    console.log('[marketplace-push] provider is not configured; inbox notifications remain available');
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await dispatchPending();
    } catch (error) {
      console.error('[marketplace-push] dispatcher failed', error.message);
    } finally {
      running = false;
    }
  };

  const expiryTick = async () => {
    try {
      await enqueueReferralExpiryNotifications();
    } catch (error) {
      console.error('[marketplace-push] referral expiry enqueue failed', error.message);
    }
  };

  const timer = setInterval(tick, POLL_INTERVAL_MS);
  const expiryTimer = setInterval(expiryTick, 60 * 60 * 1000);
  timer.unref?.();
  expiryTimer.unref?.();
  void expiryTick();
  if (providerConfigured()) void tick();
  void startPushNotificationListener();

  return () => {
    clearInterval(timer);
    clearInterval(expiryTimer);
    if (pushListenerClient) {
      pushListenerClient.release();
      pushListenerClient = null;
    }
  };
};

module.exports = {
  dispatchNotification,
  getNotificationCopy,
  sendTestNotificationToClient,
  sendFcmNotification,
  startMarketplaceNotificationDispatcher,
};
