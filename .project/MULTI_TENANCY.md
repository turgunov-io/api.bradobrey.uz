# Мульти-тенантность: аудит и план миграции

Дата аудита: 2026-11-18. Охват: `api`, `dash`, `kiosk`, `barber`, `marketplace`.
Цель: подключать другие компании (франшизы, например «Навои») к платформе как полностью изолированных арендаторов — свои услуги, цены, барберы, клиенты, статистика, киоски; никакой видимости данных Бродобрея и наоборот.

Связано: `OPEN_QUESTIONS.md:39` (вопрос «одна БД = одна сеть?» — этот документ отвечает: нет, нужна мульти-компания), `TASKS.md:5,35`, `SECURITY.md` (EQ-SEC-03 и находки по merchant/admin_branch).

## 1. Вердикт

Платформа сейчас **однокомпанийная**. Понятия «компания» нет; изоляция есть только по `branch_id`, и та во многих местах не соблюдается. Подключать вторую компанию в текущем виде **нельзя** — она увидит услуги/цены, филиалы, клиентов и сможет войти в филиалы Бродобрея.

Задача решаемая. В базе уже есть зачаток тенанта: `marketplace_barbershops` + колонка `marketplace_barbershop_id` на `branches`, `services`, `service_categories`, `promo_codes`, `certificates`, `users`; `merchant`-кабинет в dash уже работает в разрезе барбершопа. Это сокращает работу.

Ориентировочный объём: **~2.5–3.5 месяца одного разработчика** до запуска первой франшизы (без отдельных брендированных сборок marketplace).

## 2. Фаза 0 — дыры, которые надо закрыть СЕЙЧАС (не зависят от франшизы)

Это утечки уже внутри одной компании / в открытый интернет.

| # | Проблема | Где | Объём | Статус |
|---|---|---|---|---|
| 0.1 | Все HTTP-эндпоинты киоска анонимные; `branch_id` берётся из запроса. `/api/kiosk/services` отдаёт **все услуги и цены** без фильтра, `/api/kiosk/config` — все филиалы | `routers/kiosk.js:12-21`, `models/kiosk.js:252-280, 567-597` | M | ✅ `middleware/kioskAuth.js`: X-Kiosk-Token (или Bearer JWT) на `/api/kiosk/*`, филиал берётся из токена; services/config фильтруются по филиалу. Enforce за флагом `KIOSK_AUTH_ENFORCE`. Bearer в enforce-режиме: только существующий неархивный сотрудник из БД, запрошенный `branch_id` должен входить в его разрешённые филиалы (network-роли без ограничений), `/services` без `branch_id` — только его филиалы; marketplace-токен — только `/certificate/:id` и `/book` с `source=site`; остальное 403 |
| 0.2 | `/api/kiosk/register` открыт: любое устройство может зарегистрироваться в любой филиал | `services/kioskRegistration.js:105-125` | S | ✅ регистрация требует `KIOSK_ENROLLMENT_CODE` (или staff-токен: сотрудник грузится из БД, неархивный, роль и разрешённые филиалы из БД, не из JWT), rate-limit, киоск с токеном не перезаписывается |
| 0.3 | Monitor `queueStatus`/`cancelQueue` по id без авторизации — можно отменить чужую запись | `routers/monitor.js:25-26`, `models/kiosk.js:1553,1612` | S | ✅ `/api/monitor` только с kiosk-токеном, без bearer-обхода |
| 0.4 | `GET /api/services` отдаёт всю сеть любому токену (в т.ч. барберу); `getById/update/remove` по голому id | `models/services.js:119-147`, `routers/services.js:12` | S | ✅ `/api/services` скоупится по филиалам вызывающего; get/update/remove проверяют филиал записи |
| 0.5 | `finance.overview` — выручка/зарплаты всех филиалов любому с `dashboard.access` | `models/finance.js:83-260` | S | ✅ `finance.overview` ограничен филиалами вызывающего (вся сеть — только network-роли) |
| 0.6 | `admin_branch`/`merchant` видят всю сеть: расходы, штрафы, Verifix, телефоны всех клиентов marketplace, отзывы, fraud-alerts, могут слать push любому клиенту и менять глобальные настройки рекламы киоска | `models/expenses.js:4`, `penalties.js:4`, `verifix.js:4`, `marketplace/adminReports.js`, `fraudAlerts.js`, `clients.js`, `kioskAds.js:5,110` | M | ✅ expenses/penalties/verifix/cashback-settlements по branch scope; marketplace Users/Reviews/fraud-alerts/push и запись kiosk ads/loyalty — только network-роли. Verifix без `req.dbActor` → 401 (нет fallback на роль из токена; `/api/barbers/shift/*` тоже идут через `attachDbActor`). `/api/services`: `marketplace_barbershop_id` при create/update задают только network-роли |
| 0.7 | Доступ барбера к филиалам — deny-list: разрешены все активные филиалы, если нет явного запрета | `utils/employeeBranches.js:39-51` | S | ✅ allow-list: home-филиал ∪ активные строки `employee_branch_access`; backfill `employee_branch_access_allowlist_backfill.sql` |
| 0.8 | При записи в киоске услуги проверяются только по id (можно подставить услугу другого филиала) | `models/kiosk.js:819-822`, `models/barbers.js:660-679` | S | ✅ услуги проверяются на принадлежность филиалу записи (киоск, `updateQueue`, `editBeforeComplete`) |
| 0.9 | `myQueue`/`getQueueById` без проверки сессии, отдают телефоны клиентов | `models/barbers.js:2316-2487` | S | ✅ `myQueue`/`getQueueById`/`updateQueue`/`editBeforeComplete` через `authenticateBarberWorkspace` (jti + активный филиал), скоуп по барберу и филиалу сессии (`myQueue` тоже фильтрует по `branch_id` сессии) |
| 0.10 | `utils/adminAuth.js` доверяет роли из токена, а не из БД; 28 отдельных `jwt.verify` | `utils/adminAuth.js:3` | M | ✅ `authorizeAdmin`/`createAdminAuth`/`createNetworkWriteAuth` берут роль и archived из БД; sync `requireAdmin` удалён. `cashbackSettlements.js` переведён на `createAdminAuth` + `resolveAllowedBranchIds` (H2: network-роли без ограничений, `admin_branch`/`merchant` — только разрешённые филиалы; чужой филиал 403, без филиала — только свои). Остаток на Фазу 1: локальный `ADMIN_ROLES` в `verifix.js`, `requireNetworkAdmin` в `routers/cashbackSettlements.js` (reconciliation, роль из токена), прочие `jwt.verify` в `barbers.js` |
| 0.11 | Barber-приложение хранит **пароль открытым текстом** в SharedPreferences | `barber/.../auth_local_data_source.dart:177,230-233` | S | ✅ пароль в secure storage (`secure_password_store.dart`) с миграцией из SharedPreferences; логин/пароль больше не уходят в GET-запросах |

Оценка фазы: **~1–1.5 недели**. Рекомендую сделать первой, независимо от решения по франшизам.

### 2.1. Phase 0 deploy

Ветка `fix/phase0-hardening` (api + barber). Порядок важен.

> **Важно:** 0.1–0.3 до конца работают только при `KIOSK_AUTH_ENFORCE=true` и заданном `KIOSK_ENROLLMENT_CODE`. Пока они не выставлены, защита fail-open: запросы к `/api/kiosk/*` без X-Kiosk-Token проходят (Bearer-токены в этом режиме не проверяются — branch-pinning сотрудников и запрет marketplace-токенов не действуют), а `/api/kiosk/register` открыт любому устройству (warning в логе).

Шаги:

1. **БД до деплоя API.** Прогнать `db/postgres/employee_branch_access_allowlist_backfill.sql` сначала в dry-run (заменить `insert ... select` на `select * from candidates`, проверить список), затем по-настоящему. Без этого сотрудники, работающие не в своём home-филиале, потеряют к нему доступ (0.7).
2. **Индекс** `idx_kiosks_device_token_hash`: повторно применить `db/postgres/kiosks.sql` (идемпотентно, `create index if not exists`).
3. **Новые env** (см. `.env.example`):
   - `KIOSK_AUTH_ENFORCE` — держать `false`, пока **все** киоски не перерегистрированы с device-токеном и barber-приложение не обновлено (оно ходит в `/api/kiosk/services` с Bearer-токеном). При `false` запросы без токена проходят с предупреждением `[kiosk-auth] ... without X-Kiosk-Token` в логе — по нему видно, кто ещё не обновился. Потом `true` и рестарт.
   - `KIOSK_ENROLLMENT_CODE` — код регистрации киоска для `/api/kiosk/register`.
4. **admin_branch с несколькими филиалами** — нужны явные строки `employee_branch_access` (`is_active = true`) на каждый дополнительный филиал, иначе доступен только `users.branch_id`.
5. **Изменения поведения dash:** `admin_branch` получает 403 на страницах marketplace Users и Reviews (данные всей сети, только network-роли); менять настройки loyalty и рекламы киоска могут только network-роли.
6. **Follow-up (dash):** `BranchSelector` должен показывать только разрешённые филиалы (сейчас показывает все, API отвечает 403 на чужие).

## 3. Решения, которые нужны от владельца

1. **Клиентское приложение (marketplace, бренд «ŞAF»)**
   - **A. Агрегатор:** одно приложение, видны барбершопы всех компаний, общий аккаунт клиента.
   - **B. Своё приложение у каждой компании:** отдельные сборки (flavors), свой Telegram-бот, свой Firebase.
   - **C. Компромисс:** одно приложение, но аккаунт/кошелёк/уровень клиента — отдельные в каждой компании.
   Рекомендация: **C** (или A с раздельными кошельками) — меньше сборок, деньги изолированы.
2. **Барбер/киоск приложения:** одно нейтральное «платформенное» приложение с брендингом, подгружаемым после входа (рекомендую), или отдельная сборка в сторе под каждую франшизу.
3. **Ваша видимость:** видит ли «владелец платформы» статистику франшиз или только управляет их аккаунтами/подпиской.
4. **Клиенты:** один и тот же телефон у двух компаний — это два разных клиента (рекомендую) или один.
5. **Связь «компания ↔ marketplace_barbershop»:** 1:1 (просто переименовать) или компания может иметь несколько брендов (рекомендую: новая таблица `companies`, у `marketplace_barbershops` — `company_id`).

## 4. Целевая модель

- Таблица `companies` (id, name, slug, brand: logo/colors/currency/timezone, status, тариф). Бродобрей = компания №1, все текущие данные мигрируются в неё.
- `company_id NOT NULL` на корневых таблицах: `branches`, `users`, `barbers`, `kiosks`, `services`, `service_categories`, `clients`, `cashback_wallets`/транзакции/settlements, `promo_codes`, `certificates`, `banners`, `kiosk_ads`, все `warehouse_*`, `notifications`, `queue_entries`, `payments`, `finance_snapshots`, `barber_work_schedules`, quality/status events, `marketplace_*`.
- Синглтоны (`id = 1`) и `platform_settings(key)` → ключ `(company_id, key)`: `kiosk_ad_settings`, `client_rank_settings`, `verifix_settings`, cashback/loyalty/referral/no-show/anti-fraud; `CASHBACK_PERCENT` из env → в настройки компании.
- Уникальности → `(company_id, x)`: `users.login`, `clients.phone`, `promo_codes.code`, `certificates.code`, `warehouse_positions.sku`, `warehouse_categories lower(name)`, `referral_code`, `marketplace_clients.phone/telegram_user_id` (при вариантах B/C).
- **Компания только из токена/устройства**, никогда из параметров. JWT сотрудника: `{sub, role, companyId, branchId, jti}`, `companyId` сверяется с БД в `enforceEmployeeAccess`. Киоск: device token на каждом запросе → `req.kiosk = {branchId, companyId}`.
- Роли: `platform_owner` (вы) над всеми; текущие `admin`/`admin_network`/`super-manager` = «вся компания», а не «вся база». Доступ к филиалам — allow-list внутри компании.
- **PostgreSQL RLS как страховка:** AsyncLocalStorage с `companyId` → обёртка над `pool.query`/`pool.connect` в `config/postgres.js` делает `set_config('app.company_id', $1, true)` в транзакции. Приложение подключается не-владельцем таблиц (или `FORCE ROW LEVEL SECURITY`); миграции и фоновые джобы — отдельной ролью с bypass. Политика по умолчанию — deny при пустом `app.company_id`.
- Socket.IO: при `join_branch` проверять, что филиал принадлежит компании вызывающего (`socketAuth.js:50-58`).
- Uploads: префикс `companies/<id>/`.

## 5. План по фазам

| Фаза | Содержание | Оценка |
|---|---|---|
| 0 | Закрыть дыры из раздела 2 | 1–1.5 нед |
| 1 | Нумерованные миграции. Схема: `companies`, `company_id` + backfill = Бродобрей, составные уникальности, `platform_owner`. Токены с `companyId`, единый auth-хелпер вместо 28 `jwt.verify` и `adminAuth.js`. Киоск: регистрация по enrollment-коду компании | 2–3 нед |
| 2 | Скоупинг модулей API по компании (раздел 6). Сокеты. Per-company настройки вместо синглтонов. Джобы — цикл по компаниям, таймзона филиала | 3–4 нед |
| 3 | RLS: контекст запроса, `withTransaction` вместо 28 ручных `BEGIN`, политики на все тенант-таблицы, роли БД, тесты «компания B не видит A» на каждый роутер | 2 нед |
| 4 | Клиенты: dash (роль владельца платформы, переключатель компаний, глобальные страницы → по компании, брендинг из API); kiosk (enrollment-код, тема из конфига вместо `AppColor` static); barber (вход «сначала компания», неймспейс кэша, secure storage) | 2–3 нед |
| 5 | Marketplace по выбранному варианту (A/B/C): кошельки/ранги/рефералы по компании, переписать phone-триггеры, каталог по компании; при B — flavors, Telegram/Firebase на компанию | 2–4 нед |
| 6 | Онбординг франшизы: создание компании/админа из панели владельца, пилот на «Навои» | 1 нед |

Фазы 0–3 можно выкатывать на прод постепенно: пока компания одна, поведение для Бродобрея не меняется.

## 6. Реестр находок по модулям API

| Модуль | Текущее состояние | Объём |
|---|---|---|
| kiosk (`models/kiosk.js`) | анонимный, services/config глобальные, промо/сертификаты по коду глобально | M |
| barbers (`models/barbers.js`, 3.5k строк) | вход в любой филиал, сервисы по id, directory без фильтра для сетевых ролей | M–L |
| services / service_categories | list без фильтра, NULL branch = общие на всю базу | M |
| finance / statistics / history / employeeQuality | «global» = вся база | M (+L для quality-триггеров) |
| expenses / penalties | `admin_branch` видит всё; фактически хранятся в `warehouse_purchases` | M |
| warehouse | 6 глобальных таблиц, nullable branch, глобальный SKU | L |
| promocode / certificate | глобальные коды и списки | M |
| verifix | глобальный синглтон настроек; внешних API нет | M |
| merchant (1.2k строк) | уже скоуп по `marketplace_barbershop_id`; авто-привязка `resolveSingleBarbershopId` (`merchant.js:102-135`) сломается при нескольких компаниях | L |
| kioskAds / loyalty / notifications | синглтоны; рассылка сетевым ролям всей базы | S |
| marketplace (catalog, auth, profile, admin, compliance) | одна личность/кошелёк/ранг на телефон, триггеры матчат клиентов по цифрам телефона (`marketplace_tz_compliance.sql:278,657,805`), глобальные настройки, админка без скоупа | L |
| jobs (autoClose, cashbackReconciliation, referralBonus, push, sessionCleanup) | обходят все строки; autoClose с одной таймзоной | M |
| БД-доступ | ~600 `.query(`, ~370 `db.from()`, 51 файл импортирует `pool`, 28 ручных транзакций, мигратора нет (идемпотентные SQL через `scripts/apply-schema.sh`) | — |

Интеграции с платформенными ключами (env): `JWT_SECRET`, `TELEGRAM_BOT_TOKEN/USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `MARKETPLACE_PUSH_WEBHOOK_*`, `SMTP_*`, `VAPID_*`. На компанию их выносить нужно только если у франшизы своё брендированное приложение (вариант B). Платёжных шлюзов нет (Payme/Click — только метки способа оплаты).

## 7. Клиенты

- **dash:** бренд в нескольких местах (`app.vue`, `SidebarBrand.vue`, `PageLoader.vue`, manifest) — легко вынести в конфиг; цвета уже CSS-токены. Скоуп филиала ставится на клиенте (`useApiClient.ts:43-78`) — для изоляции не годится. Предположение «admin видит всё»: `shared/auth/employees.ts:320`, `BranchSelector.vue:120`. Глобальные страницы: `settings/*`, `dashboard/marketplace/*`, `statistics/*`, `api-debug.vue`. Валюта/таймзона захардкожены (UZS, Asia/Tashkent).
- **kiosk:** один APK с брендингом из конфига реалистичен. Кэш в SharedPreferences (`selected_branch_id`, `cached_service_catalog_v2`), sqflite не используется.
- **barber:** экран входа грузит **все филиалы** из публичного `/kiosk/config`. Нужен вход «сначала компания» (код/телефон). Имя в сторе и Firebase-проект на рантайме не меняются → нейтральное приложение или flavors. Кэш-ключи не неймспейсятся.
- **marketplace:** уже бренд «ŞAF» и по сути агрегатор. Захардкожены реферальная ссылка `bradobrey.uz/referral` (`referral_page.dart:51`), Supabase defaults (`app_environment.dart:19-32`).
- Все iOS bundle id — `com.example.*`.

## 8. Риски

- Пропущенный фильтр = утечка цен/клиентов. Поэтому RLS обязателен, плюс тест-набор изоляции на каждый роутер.
- RLS при неправильной роли БД молча не работает (владелец таблиц обходит политики) — проверять тестом.
- Миграция `clients.phone` → `(company_id, phone)` и кошельков затрагивает деньги клиентов: бэкап и сверка балансов до/после.
- Отсутствие мигратора и `node_modules` в репозитории усложняют выкатку; нумерованные миграции завести до фазы 1.
