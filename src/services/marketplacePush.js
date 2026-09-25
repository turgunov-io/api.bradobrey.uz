const { pool } = require('../config/postgres');
const { isMarketingNotification, isQuietHoursAt } = require('../utils/marketplacePushPolicy');
const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const POLL_INTERVAL_MS = Math.max(5000, Number(process.env.MARKETPLACE_PUSH_POLL_MS || 15000));

const notificationCopy = {
  BOOKING_CREATED: {
    title: 'Бронирование создано',
    body: 'Вы добавлены в живую очередь.',
  },
  BOOKING_CANCELLED: {
    title: 'Бронирование отменено',
    body: 'Ваше бронирование отменено.',
  },
  REFERRAL_BONUS: {
    title: 'Начислен реферальный бонус',
    body: 'Ваш бонус за приглашение доступен в профиле.',
  },
  LEVEL_CHANGED: {
    title: 'Изменился уровень лояльности',
    body: 'Проверьте новый уровень и доступные привилегии.',
  },
  ACCOUNT_BLOCKED: {
    title: 'Аккаунт временно ограничен',
    body: 'Откройте приложение, чтобы узнать подробности.',
  },
  ACCOUNT_BLOCKED_CANCELS: {
    title: 'Аккаунт временно ограничен',
    body: 'Лимит отмен за сегодня превышен. Проверьте подробности в приложении.',
  },
  NO_SHOW: {
    title: 'Неявка зафиксирована',
    body: 'Баллы статуса изменены. Проверьте подробности в профиле.',
  },
  NO_SHOW_PENALTY: {
    title: 'Неявка зафиксирована',
    body: 'Баллы статуса изменены. Проверьте подробности в профиле.',
  },
  YOU_ARE_CALLED: {
    title: 'Вас вызывают',
    body: 'Подойдите к выбранному барберу.',
  },
  SERVICE_STARTED: {
    title: 'Услуга началась',
    body: 'Барбер начал обслуживание.',
  },
  SERVICE_COMPLETED: {
    title: 'Услуга завершена',
    body: 'Спасибо за визит. Оцените обслуживание в приложении.',
  },
  REFERRAL_EXPIRING: {
    title: 'Реферальный бонус скоро истечёт',
    body: 'У вас осталось 30 дней, чтобы воспользоваться реферальной возможностью.',
  },
  QUEUE_POSITION_CHANGED: {
    title: 'Изменилась позиция в очереди',
    body: 'Откройте приложение, чтобы увидеть актуальное ожидание.',
  },
  ALMOST_YOUR_TURN: {
    title: 'Скоро ваша очередь',
    body: 'Пожалуйста, будьте готовы подойти к барберу.',
  },
  BARBER_READY: {
    title: 'Барбер готов',
    body: 'Ваш барбер готов принять вас.',
  },
  CASHBACK_EARNED: {
    title: 'Начислен кешбек',
    body: 'Кешбек за завершённую услугу доступен в кошельке.',
  },
  PROMO_FROM_SHOP: {
    title: 'Новое предложение',
    body: 'В выбранном барбершопе появилось новое предложение.',
  },
};

const providerUrl = () => String(process.env.MARKETPLACE_PUSH_WEBHOOK_URL || '').trim();

let firebaseMessaging = null;
let firebaseInitializationAttempted = false;

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
  } catch (error) {
    console.error('[marketplace-push] invalid FIREBASE_SERVICE_ACCOUNT_JSON:', error.message);
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
    console.error('[marketplace-push] Firebase initialization failed:', error.message);
    return null;
  }
};

const providerConfigured = () => Boolean(getFirebaseMessaging() || providerUrl());

const sendToProvider = async ({
  token,
  platform,
  type,
  payload,
  notificationId,
  title: customTitle,
  body: customBody,
}) => {
  const copy = notificationCopy[type] || {
    title: 'BRADOBREY',
    body: 'У вас новое уведомление.',
  };
  const title = String(customTitle || copy.title).trim();
  const body = String(customBody || copy.body).trim();

  const messaging = getFirebaseMessaging();
  if (messaging) {
    const data = Object.fromEntries(
      Object.entries({
        type,
        notification_id: notificationId,
        ...(payload || {}),
      }).map(([key, value]) => [key, String(value ?? '')]),
    );
    await messaging.send({
      token,
      notification: { title, body },
      data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'queue_reminders_v2',
          sound: 'default',
        },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    });
    return { delivered: true };
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
       select n.id, n.marketplace_client_id, n.type, n.payload, t.token, t.platform
       from claimed c
       join marketplace_notifications n on n.id = c.id
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

  return () => {
    clearInterval(timer);
    clearInterval(expiryTimer);
  };
};

module.exports = {
  dispatchNotification,
  sendTestNotificationToClient,
  startMarketplaceNotificationDispatcher,
};
