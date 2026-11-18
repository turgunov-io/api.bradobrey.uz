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

## 3. Решения владельца

### 3.1. Принято 2026-11-18

| # | Решение | Как отражено в схеме (Фаза 1, шаг A) |
|---|---|---|
| D1 | **Компания = один marketplace-барбершоп (бренд) = сколько угодно филиалов.** Пример: «Bradobrey» — 50 филиалов, «President» — 15; у каждой свои услуги и цены, **цены никогда не смешиваются**. | `companies` + `marketplace_barbershops.company_id unique` (1:1); `company_id` на всех тенант-таблицах; триггер `tenant_company_guard` запрещает ссылку на филиал/услугу/барбера/клиента другой компании |
| D2 | **Киоск и barber-приложение:** сначала вводится уникальный **код компании** → компания определена → выбор филиала **только этой компании** → регистрация киоска / вход барбера. | `companies.code` (уникален без учёта регистра, `^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$`); Bradobrey = `BRADOBREY` (меняется через `MIGRATE_SEED_COMPANY_CODE` или `update companies set code = ...`) |
| D3 | **Один телефон в двух компаниях = два разных клиента.** | `clients.company_id`, уникальность `(company_id, phone)` |
| D4 | **Владелец платформы видит только управление** (создание компаний, их админов, включение/отключение), не статистику и клиентов франшиз. | роль `platform_owner`, `users.company_id IS NULL` только у неё (`users_company_membership_check`); `companies.status` `active`/`suspended`; доступа к данным роль не получает |

Из исходного списка остаются открытыми: вариант для marketplace-приложения (A/B/C ниже; влияет на `marketplace_clients`, кошельки, баллы, рефералы — Фаза 5) и вопрос сборок barber/kiosk (одна нейтральная с брендингом из API или flavors).

### 3.2. Исходные вопросы (для истории)

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
| 1 | Нумерованные миграции. Схема: `companies`, `company_id` + backfill = Бродобрей, составные уникальности, `platform_owner`. Токены с `companyId`, единый auth-хелпер вместо 28 `jwt.verify` и `adminAuth.js`. Киоск: регистрация по enrollment-коду компании. **Шаг A (БД) и B1 (auth + вход по коду компании) — сделаны в ветке `feat/phase1-companies`, не применены на прод; см. раздел 9.** Шаг B2 (скоупинг данных) — следующий | 2–3 нед |
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

## 9. Фаза 1: шаг A — схема БД, шаг B — auth и скоупинг данных (статус на 2026-11-18)

Ветка `feat/phase1-companies`. **Не применено ни к одной БД и не закоммичено** (локального Postgres не было — SQL не исполнялся, проверен ревью и контрактными/статическими тестами). Перед продом **обязательна репетиция на копии прод-БД** (порядок — 9.9).

### 9.1. Что сделано

- Мигратор: `db/migrations/NNN_*.sql` + `scripts/migrate.js` (`npm run migrate`, `npm run migrate -- --dry-run`), логика в `scripts/lib/migrationRunner.js`, тесты `test/migrationRunner.test.js`. Таблица `schema_migrations(version, name, checksum, execution_ms, applied_at)`, каждый файл в своей транзакции, advisory lock, `lock_timeout` (по умолчанию 15s, `MIGRATE_LOCK_TIMEOUT`), отказ при изменении уже применённого файла. Порядок деплоя: `apply-schema.sh` (база) → `npm run migrate` (см. `DEPLOYMENT.md`).
- `001_companies` — `companies` (+ `is_default` для Bradobrey), `marketplace_barbershops.company_id unique`, backfill барбершопов.
- `002_tenant_company_id` — `company_id` на тенант-таблицах, backfill, FK, NOT NULL, индексы, триггер `tenant_company_guard`.
- `003_tenant_composite_uniques` — составные уникальности **в дополнение** к глобальным; синглтоны по компании.
- `004_platform_owner_role` — роль `platform_owner`, `users.company_id` NULL только у неё. Базовые `db/postgres/users.sql` / `user_permissions.sql` тоже знают роль.
- `005_company_scoped_functions` — SQL-функции по компании (`tenant_setting(key, company)`, уровни лояльности, триггеры баллов/рефералов, ранги клиентов). `006_warehouse_categories_company` — уникальность категорий склада по компании.
- `007_drop_global_uniques` (бывший `deferred/101`, перенесён 2026-11-18 после шага B2) — удаление глобальных уникальностей (`users.login`, `clients.phone`, `promo_codes.code`, `certificates.code`, `referral_accounts.referral_code`, `idx_warehouse_positions_sku`, `idx_warehouse_categories_name`), PK `platform_settings (company_id, key)`, FK `referrals → referral_accounts (company_id, referral_code)`. **Не совместим со старым кодом API** — только вместе с кодом шага B (9.9). Папки `deferred/` больше нет.
- `008_company_kiosk_enrollment` — `companies.kiosk_enrollment_code_hash` (per-company код регистрации киоска, 9.10/H1). Аддитивная, но новый код API читает колонку — применить до деплоя кода.
- Откаты: `db/migrations/down/*.down.sql` (вручную, `psql -1`). Проверки: `db/checks/multi_tenancy_checks.sql` (A — preflight до миграции, B–D — после; все `problem_rows` должны быть 0).
- `PLATFORM_ROLES` экспортируется из `src/utils/employeeQualityAccess.js` (не входит в NETWORK/BRANCH/SELF — доступа нет).

### 9.2. Логика backfill и допущения

- Компания №1 = Bradobrey (`is_default`, код `BRADOBREY`, переопределяется `MIGRATE_SEED_COMPANY_CODE` / `_NAME`).
- Барбершоп Bradobrey = `MIGRATE_SEED_BARBERSHOP_ID`, иначе барбершоп с наибольшим числом филиалов (при равенстве — самый старый). Каждый прочий барбершоп получает свою компанию (`SHOP_<8 hex id>`, переименовать вручную). Если у прочего барбершопа **есть филиалы**, 001 падает, пока не задано `MIGRATE_ALLOW_BARBERSHOP_SPLIT=on` — живые филиалы молча не уводятся из Bradobrey. Код (`merchant.resolveSingleBarbershopId`) предполагает один барбершоп, так что ожидаемый прод-случай — ровно один.
- Строки получают компанию родителя: филиал → барбершоп; пользователь → филиал, иначе барбершоп; услуги/категории → филиал, иначе барбершоп; промо/сертификаты → барбершоп; киоски, склад, расписания, события → филиал/барбер/заказ; кошельки и транзакции → клиент. Без родителя (сетевые админы, клиенты, баннеры, глобальные услуги с NULL филиалом, синглтоны, `platform_settings`) → Bradobrey. Все существующие `clients` → Bradobrey (даже при split).
- Колонка добавляется с константным default (без перезаписи таблиц), default сразу снимается; UPDATE по родителям выполняется только если компаний больше одной (пользовательские триггеры на время UPDATE отключаются и включаются обратно).
- **Переходный fallback:** триггер подставляет компанию №1, если её нельзя вывести из родителя, — чтобы текущий код, не знающий о компаниях, продолжал работать. `set app.tenant_strict = 'on'` превращает это в ошибку; включить по умолчанию после шага B (и тогда удалить fallback).
- Охранник несовпадения срабатывает только на INSERT и на UPDATE, затрагивающем `company_id` или колонку-родителя, поэтому исторические несоответствия не ломают обычные UPDATE (их показывает `multi_tenancy_checks.sql`). Охраняются все таблицы из 9.3, в т.ч. `services`, `kiosks`, `users`, `barbers`, `queue_entries` (филиал, барбер, услуга, клиент, сертификат), `employee_branch_access` (сотрудник ↔ филиал).
- `marketplace_barbershops.company_id` оставлен nullable без автозаполнения: создание барбершопа в marketplace-админке его пока не ставит, а автоподстановка Bradobrey нарушила бы 1:1.

### 9.3. Таблицы с `company_id`

`branches`, `users` (nullable только для `platform_owner`), `barbers`, `employee_branch_access`, `employee_active_branches`, `kiosks`, `branch_locations`, `barber_login_location_events`, `service_categories`, `services`, `clients`, `cashback_wallets`, `cashback_transactions`, `cashback_settlements`, `cashback_reconciliation_alerts`, `promo_codes`, `promo_code_usage`, `certificates`, `banners`, `media_assets`, `kiosk_ad_settings`, `client_rank_settings`, `verifix_settings`, `platform_settings`, `warehouse_positions`, `warehouse_templates`, `warehouse_template_items`, `warehouse_stocks`, `warehouse_purchases` (там же расходы/штрафы), `warehouse_purchase_items`, `warehouse_categories`, `expenses` (если существует; в `apply-schema.sh` не входит), `queue_entries`, `payments`, `finance_snapshots`, `notifications`, `barber_work_schedules`, `barber_activity_events`, `queue_status_events`, `queue_transfer_events`, `queue_quality_assessments`, `queue_quality_review_events`, `queue_quality_plan_snapshots`, `marketplace_reviews`, `marketplace_review_alerts`, `client_barbershop_origins`, `marketplace_no_show_violations`, `referral_accounts`, `referrals`, `referral_transactions`. Отсутствующие в БД таблицы пропускаются с NOTICE.

### 9.4. Таблицы, намеренно оставленные без `company_id`

| Таблица | Причина |
|---|---|
| `companies`, `schema_migrations`, `schema_data_migrations` | платформенные / служебные |
| `marketplace_barbershops` | это и есть связь с компанией (`company_id`, nullable — см. 9.2) |
| `marketplace_clients`, `otp_codes`, `telegram_auth_challenges`, `marketplace_push_tokens`, `marketplace_notifications`, `marketplace_audit_logs`, `marketplace_fraud_alerts`, `marketplace_idempotency_requests`, `status_point_transactions` | личность/аккаунт клиента приложения ŞAF и его баллы — зависят от неразрешённого варианта A/B/C → Фаза 5 |
| `marketplace_bookings`, `marketplace_booking_persons`, `marketplace_booking_person_services` | бронь создаётся раньше своих `queue_entries`, компанию на INSERT вывести нельзя; сейчас она выводится через `marketplace_booking_persons.queue_entry_id → queue_entries.company_id`. Колонка — в Фазе 5, когда API брони примет барбершоп явно |
| `user_permissions`, `push_subscriptions`, `employee_push_tokens` | строго дочерние к `users` (FK `user_id`), компания = компания пользователя |

### 9.5. ON CONFLICT / upsert и поиски по ключу — переведены на ключ с компанией (сделано, 2026-11-18)

Все места, которые зависели от глобальных уникальностей, удаляемых 007, переведены; поэтому 101 перенесён в `db/migrations/007_drop_global_uniques.sql`. Регрессии ловят тесты:

- `test/onConflictTargets.test.js` — статически собирает каталог уникальных ключей (PK, UNIQUE, unique-индексы) из `apply-schema.sh` + всех `db/postgres/*.sql` + `db/migrations/001–007` (`test/helpers/uniqueIndexCatalog.js`) и проверяет, что **каждая** цель `on conflict (...)` / `.upsert(..., { onConflict })` в `src/`, `db/postgres` и миграциях совпадает с существующим ключом после 007. Плюс sanity: глобальных `clients.phone`, `promo_codes.code`, `certificates.code`, `referral_accounts.referral_code`, `platform_settings.key` больше нет.
- `test/companyMarketplaceKeys.test.js` — ни один файл `src/` не читает `platform_settings` только по `key`; реферальные коды; групповая бронь; no-show.
- `test/companyServicePrices.test.js` — ни одного `services`-запроса в `src/` без company-скоупа.

Что было и как закрыто:

| Было | Стало |
|---|---|
| `clients.phone`: `referralBonus.js` `on conflict (phone)`, триггеры `marketplace_tz_compliance.sql` | `on conflict (company_id, phone)`, компания из строки (B2a, 005) |
| `groupBooking.js`: клиент создаётся без компании, legacy-клиент ищется по телефону во всех компаниях | клиент ищется/создаётся в компании филиала брони (`on conflict (company_id, phone)`), `queue_entries.company_id` пишется явно |
| `platform_settings` по `key`: `loyalty.js`, `marketplace/settings.js`, `cashback.js`, сиды | `company_id = …` / `onConflict: 'company_id,key'` (B2a) |
| `platform_settings` по `key`: `groupBooking.js` (`booking_limits`), `compliance.js` (`loyalty_levels`, `no_show_restrictions`, `anti_fraud`, `status_points`), `marketplace/auth.js` и `services/telegramAuth.js` (`referral`), `marketplaceNoShowRestriction.js` | `tenant_setting(key, company)` через `src/utils/tenantSettings.js readTenantSetting`; компания — из обрабатываемой строки (см. ниже) |
| `referral_accounts.referral_code`: поиск кода при регистрации (`auth.js` ×2, `telegramAuth.js`), backfill в `referralBonus.js`, генерация кода в `compliance.js` | `src/utils/referralAccounts.js findReferralAccountByCode`: код должен найтись **ровно в одном** аккаунте (`limit 2`, два → «неверный код»); `referrals.company_id` = компания аккаунта (нужно для FK после 007); backfill пропускает коды, существующие в двух компаниях; новый код генерируется уникальным по всей платформе (`where not exists`) |
| логин, промокоды, сертификаты, SKU, категории склада | по `(company_id, …)` (B1/B2a); runtime-DDL глобальных индексов склада убран |
| синглтоны `id = 1` (`kiosk_ad_settings`, `client_rank_settings`, `verifix_settings`) | чтение/запись по `company_id` (`onConflict: 'company_id'`, `ON CONFLICT (company_id)`); сиды — 9.8 |
| `src/models/marketplace/catalog.js` (легаси, промо/сертификаты по коду) | **удалён**: ни роутов, ни `require`, ни тестов (каталог — `src/modules/marketplace/catalog/`) |

Откуда компания для настроек:

- есть строка — её компания: групповая бронь → `branches.company_id` филиала; отмена брони → `queue_entries.company_id` персон брони; no-show → `queue_entries.company_id`; реферал при регистрации → `referral_accounts.company_id` аккаунта-владельца кода;
- строки нет (экран лояльности `GET /api/marketplace/compliance/loyalty`, `…/restriction`, создание своего реферального кода `…/referral`) — `?branch_id` → компания филиала; без него — дефолтная компания **только пока компания одна** (`legacyDefaultCompanyId`); иначе `400 BRANCH_REQUIRED` (как у `GET /api/loyalty/ranks` и `GET /api/kiosk/certificate/:id`). Почему не «всегда дефолтная»: при двух компаниях это молча применяло бы правила Bradobrey к клиентам President;
- нет компании вовсе — встроенные дефолты кода (`readTenantSetting` → `null`), никогда строка другой компании.

Не затронуты (ключ не меняется, компания выводится из родителя): `cashback_wallets (client_id)`, `cashback_settlements (queue_entry_id)`, `client_barbershop_origins`, `employee_branch_access`, `employee_active_branches (employee_id)`, `finance_snapshots (branch_id, period)`, `kiosks (branch_id, device_name)`, `notifications`, `branch_locations (branch_id)`, upsert `barbers`/`users` по `id`, `marketplace_clients (phone)` (платформенные до Фазы 5).

Где подключить `platform_owner`: сделано в B1 (`/api/platform/*`, guard в `adminAuth`/`staffAccess`). В списки `SOCKET_EMPLOYEE_ROLES`, `ROLE_RANK`, `EMPLOYEE_ROLES`, `MERCHANT_ALLOWED_ROLES` роль **не** добавлять. dash — вне охвата.

### 9.6. Риски шага A

- SQL не исполнялся: прогнать `npm run migrate` + `db/checks/multi_tenancy_checks.sql` на копии прод-дампа обязательно.
- Блокировки: ALTER на каждой таблице (ACCESS EXCLUSIVE), SET NOT NULL, FK и индексы сканируют `queue_entries`, `queue_status_events` и т.п. — окно обслуживания, API остановить или ожидать ошибок `lock_timeout`.
- Новый триггер на горячих таблицах — +1 поиск по PK родителя на INSERT; на UPDATE без смены родителей — no-op.
- Охранник отклонит INSERT/UPDATE, смешивающий компании (это цель), — в живых данных возможно только при split-сценарии; уведомления сетевым ролям «всей базы» (`models/notifications.js`) начнут падать, как только появится вторая компания до шага B.
- Fallback на Bradobrey маскирует пропущенный `company_id` в коде — включить `app.tenant_strict` после шага B.
- ~~Повторный `apply-schema.sh` после 101 пересоздаст глобальные индексы склада~~ — закрыто: `warehouse.sql` и `warehouse.js` их больше не создают.

### 9.7. Шаг B1 — auth и вход по коду компании (сделано, не задеплоено)

**Требует миграций 001–004** (`npm run migrate`) до деплоя кода: загрузчики читают `users.company_id`, `companies`, `branches.company_id`; без них каждый staff-запрос → 500. Контракт эндпоинтов — `API.md`, раздел «Companies».

- **Единый JWT-хелпер** `src/utils/authToken.js` (`verifyAny` / `verifyStaffToken` / `verifyMarketplaceToken` / `getBearerToken`), алгоритм закреплён на HS256. Все 34 вызова `jwt.verify` в `src` (24 файла) заменены механически на `verifyAny` (поведение то же, + проверка алгоритма); тест `authToken.test.js` падает, если `jwt.verify` появится вне хелпера. `jwt.sign` пока остаётся в `models/barbers.js`, `models/marketplace/auth.js`, `services/telegramAuth.js`, `models/platform.js` (HS256 по умолчанию).
- **Токен сотрудника** получает `companyId` (из `users.company_id` при входе). `src/utils/tenant.js checkTenantAccess`: компания всегда из БД, claim только сверяется (`401 TOKEN_COMPANY_MISMATCH`), `403 COMPANY_SUSPENDED`, `403 COMPANY_REQUIRED`; старые токены без `companyId` принимаются. Проверка встроена в `enforceEmployeeAccess` (теперь и для `merchant`, `platform_owner`), `adminAuth` (`createAdminAuth`, `attachDbActor`), `staffAccess`, `employeeManagement`, `kioskAuth` (bearer и device token через филиал киоска), `kioskRegistration`, statistics/history auth, сокеты. `req.tenant = { companyId, isPlatformOwner }`.
- **Network-роли = вся компания:** `resolveAllowedBranchIds`/`resolveStaffBranchScope` для network-ролей возвращают список филиалов компании (помечен `isCompanyWideScope`, больше никогда `null`); `listEmployeeBranches` фильтрует `b.company_id = users.company_id`; справочник сотрудников, цели/филиалы в `employeeManagement`, устройства киоска, `join_branch`, branch-скоупы statistics/history — только своя компания. Для совместимости: `services.canModifyService` разрешает company-wide скоупу менять услуги с `branch_id NULL`, `finance.overview` для network-ролей по-прежнему игнорирует запрошенный филиал (но в пределах компании).
- **platform_owner:** `POST /api/platform/login`, `GET/POST /api/platform/companies`, `PATCH /api/platform/companies/:id`, `POST /api/platform/companies/:id/admins` (роль проверяется в БД). На всех остальных маршрутах — `403 PLATFORM_OWNER_NO_TENANT_ACCESS`. Дефолтную компанию приостановить нельзя (`409`).
- **Код компании:** `POST /api/companies/resolve` (rate-limit по IP, одинаковый 404 для неизвестной/приостановленной). `POST /api/kiosk/register` и staff-логины принимают `company_code`; без него — fallback на дефолтную компанию с warn **только пока компания одна** (и киоск, и staff-логин — staff с 9.10/M4; иначе `400 COMPANY_CODE_REQUIRED`).

**Статус пунктов, оставленных на B2** (B2a/B2b и завершение 2026-11-18, см. 9.8):
- ✅ `scope.type === 'global'` в statistics/employeeQuality/history — SQL ограничен компанией (`requireAccessCompanyId`).
- ✅ `cashbackSettlements requireNetworkAdmin`, `ADMIN_ROLES` в `verifix.js` — по компании из БД.
- ✅ Синглтоны и глобальные списки (`kiosk_ad_settings`, `client_rank_settings`, `verifix_settings`, `platform_settings`, loyalty, уведомления, marketplace-админка) — по компании.
- ✅ Услуги/промо/сертификаты/клиенты/склад — выборки по id/коду с `company_id` (9.5, 9.8); создание сотрудника ставит `company_id` явно, логин уникален в компании.
- ✅ Перенос `deferred/101` → `007` (9.5).
- ⏳ `app.tenant_strict` — **не включён**, подготовлено (9.9).
- ✅ `GET /api/kiosk/config` — филиалы только компании запроса (киоск/токен, иначе дефолтная, пока компания одна; при двух — пустой список с `code: COMPANY_CODE_REQUIRED`). Публичность эндпоинта (без кода компании) убрать после перехода barber-приложения на `/api/companies/resolve`.
- ⏳ `merchant.resolveSingleBarbershopId` — fallback «единственный барбершоп» остаётся для legacy-назначений; создание барбершопа в marketplace-админке не ставит `company_id` (9.2).
- ✅ Per-company код регистрации киоска — сделано (9.10, H1, миграция 008).

**Риски B1:** (1) деплой кода раньше миграций — 500 на всех staff-запросах; (2) приостановка компании мгновенно режет её сотрудникам и киоскам все запросы; (3) network-админы теряют доступ к строкам с `branch_id NULL` в expenses/penalties/verifix (там фильтр `branch_id = any(scope)`), кроме услуг; (4) socket `join_branch` теперь делает +1 запрос к `branches`; (5) ~~один `KIOSK_ENROLLMENT_CODE` на всю платформу~~ — закрыто, per-company коды (9.10).

### 9.8. Шаг B2 — завершение скоупинга данных (сделано 2026-11-18, не задеплоено)

**Услуги и цены никогда не смешиваются между компаниями (D1, главный приоритет владельца).** Правило в одном месте — `src/utils/serviceScope.js`: услуга применима к записи очереди, только если `services.company_id = компания записи` (`queue_entries.company_id`, иначе компания её филиала) **и** `services.branch_id IS NULL OR = филиал записи`. Компания неизвестна → ни одна услуга не применяется (цена 0 / «service_ids are invalid»), а не «строка любой компании с этим id».

- `src/models/barbers.js`: все 5 поисков услуг по id — `loadQueueServices` (прикрепление услуг барбером, теперь всегда company+branch), `getQueueEntryAmount` (сумма заказа при завершении → кэшбэк/платежи), `getCompletedQueueRevenue` и `getBarberWorkStatistics` (выручка/финансы барбера), `getBranchBarberAvailability` (длительности для ETA).
- Остальной `src/`: `history.js` (суммы истории), `kiosk.js` (ETA очереди, `GET /api/kiosk/barbers/:branch_id`, идемпотентный повтор брони), `notifications.js` (подозрительные заказы), `statistics.js` (заказы филиала), `finance.js` (оборот: join услуг с `s.company_id = q.company_id` и правилом филиала), `composable/cashback.js` (+ правило филиала), `marketplace/compliance.js` (ETA и названия услуг активной брони), `marketplace/groupBooking.js` (валидация услуг и цены персон — `company_id` + филиал), `merchant.js` (суммы заказов; **удаление услуги было без всякого фильтра — теперь только своего барбершопа**), `modules/marketplace/catalog/repository.js` (ETA и коэффициент скорости барбера), `services/referralBonus.js` (+ правило филиала).
- Тест `companyServicePrices.test.js`: две компании с общим id-пространством; цена чужой общей услуги не попадает ни в запись, ни в сумму; статическая проверка — ни одного `from('services')` / `from|join services` без company-скоупа в `src/`.

**Штрафы** (`src/models/penalties.js`): как `expenses.js` — фильтр `company_id` из БД (`403 COMPANY_REQUIRED` без компании), network-роли (company-wide scope) без branch-списка → видят и отменяют строки своей компании с `branch_id NULL`; branch-роли — по своим филиалам внутри компании. Опоздания из `barber_activity_events` — тоже `e.company_id`. Создание пишет `company_id` явно, получатель проверяется в компании. Попутно исправлен баг: `create` падал с `ReferenceError: tashkentDate is not defined` (был и на `HEAD`) — теперь `zonedDateString` из `utils/timezone`. Тест `companyPenaltiesScope.test.js`.

**Глобальные ключи** — см. таблицу в 9.5.

**Сиды `db/postgres` без опоры на fallback триггера.** Строки без родителя, которые раньше получали компанию №1 только от fallback-а триггера, теперь пишут `company_id` явно (дефолтная компания), если таблица `companies` и колонка `company_id` уже есть; на свежей БД (до 001–003) — прежний сид `id = 1` / по `key`:
`client_ranks.sql` (`client_rank_settings`), `kiosk_ads.sql` (`kiosk_ad_settings`), `verifix.sql` (`verifix_settings`), `loyalty_points_reversal.sql` и `marketplace_tz_compliance.sql` (`platform_settings`). Существующие строки не перезаписываются (`where not exists`). Остальные вставки в `db/postgres` (`employee_branch_access`, `queue_status_events`, `queue_quality_*`, `cashback_*`, `referral_transactions`, `clients` в триггерах 005) выводят компанию из родителя, а не из fallback. Тест — `companySqlFunctions.test.js`. Новые компании получают свои строки настроек при первом сохранении админом; до этого код использует встроенные дефолты.

Известные остатки (не сделано): `UPDATE platform_settings … where key = 'status_points'` в `marketplace_tz_compliance.sql` — разовые идемпотентные коррекции старых дефолтов, применяются ко всем компаниям (безвредно, ключ не используется как уникальный); marketplace-приложение (`referral_page.dart`, экраны лояльности/ограничений) пока не передаёт `branch_id` — до второй компании обновить (иначе `400 BRANCH_REQUIRED` у клиентов без реферального аккаунта).

### 9.9. Порядок деплоя Фазы 1 и `app.tenant_strict`

**Репетиция на копии прод-БД обязательна** (SQL нигде не исполнялся): весь порядок ниже + `db/checks/multi_tenancy_checks.sql` (все `problem_rows` = 0) + смоук API.

1. Бэкап БД. Секция A `multi_tenancy_checks.sql` (какой барбершоп — Bradobrey; env `MIGRATE_SEED_*` при необходимости, см. 9.2 и `DEPLOYMENT.md`).
2. **Окно обслуживания, API остановлен** (007 несовместим со старым кодом: старый код делает `on conflict (phone)` / `on conflict (key)`; ALTER-ы берут ACCESS EXCLUSIVE).
3. `scripts/apply-schema.sh` — базовые файлы новой версии (идемпотентно; на этом шаге сиды ещё идут по legacy-ветке, если 001 ещё не применялась).
4. `npm run migrate` — 001 → 008 (каждая в своей транзакции; 008 — коды регистрации киосков, 9.10). Перед 007 секция D чек-файла должна быть 0 (нет дублей логина/телефона/кода внутри одной компании); при ошибке — `down/` в обратном порядке.
5. Секции B–D `multi_tenancy_checks.sql` → 0.
6. Деплой API этой ветки, рестарт PM2, смоук: вход сотрудника, киоск-бронь, завершение заказа (сумма = цены своей компании), marketplace-бронь/отмена, `GET /api/marketplace/compliance/loyalty`.
7. Обновить приложения (barber/kiosk — ввод кода компании; marketplace — `branch_id` в лояльности/ограничениях/реферале) **до** создания второй компании.

**Гейт второй компании (сделано, 9.10).** `POST /api/platform/companies` и `PATCH …/:id { status: "active" }` для приостановленной не-дефолтной компании отвечают `409 MULTI_COMPANY_PRECONDITIONS` со списком `failed`, пока не выполнены **автоматически проверяемые** условия:
- `KIOSK_AUTH_ENFORCE=true` в env API (`failed: "KIOSK_AUTH_ENFORCE"`; принимается любое значение, которое `middleware/kioskAuth` считает включённым: `true/1/yes/on`);
- `select current_setting('app.tenant_strict', true)` = `on` на соединении API (`failed: "TENANT_STRICT"`).

Ручные условия (код их не проверяет — чек-лист перед созданием второй компании):
- kiosk/barber-приложения обновлены и вводят код компании; все киоски получили device token (после `KIOSK_AUTH_ENFORCE` без него — 401);
- **dash: добавить поле «код компании» в форму входа** и передавать `company_code` в `POST /api/barbers/login` / `admin/login` (`dash/server/api/barbers/login.post.ts` сейчас его не шлёт). С двумя компаниями вход без кода — `400 COMPANY_CODE_REQUIRED` (M4): без этого dash перестанет пускать **всех**, включая Bradobrey;
- компаниям заданы свои коды регистрации киосков (`PATCH /api/platform/companies/:id { kiosk_enrollment_code }` или `PUT /api/kiosk/enrollment-code`), иначе киоски регистрируются только через staff;
- marketplace-приложение передаёт `branch_id` (9.8).

**`app.tenant_strict`** (не включён). Это **обязательное условие гейта**: пока он не `on`, вторую компанию создать нельзя. Сейчас триггер `tenant_company_guard` подставляет компанию №1, если её нельзя вывести из родителя; `set app.tenant_strict = 'on'` превращает это в ошибку. Код шага B везде пишет `company_id` явно или вставляет строки с родителем, сиды — тоже (9.8). Включать:
- когда: после деплоя шага B, **до** создания второй компании, после ≥ 1 недели без ошибок;
- как: сначала на копии/стейдже — `alter database <db> set app.tenant_strict = 'on'` (или `alter role <api_role> set …`), затем **переподключить** API (`pm2 restart`: настройка базы применяется только к новым соединениям пула; проверка — `select current_setting('app.tenant_strict', true)` под ролью API), прогнать смоук и `apply-schema.sh` (сиды должны пройти); на проде — то же в окне, следить за логами на ошибки триггера `<table>.company_id is required (app.tenant_strict)`; откат — `alter database <db> reset app.tenant_strict`;
- после стабилизации — отдельной миграцией убрать fallback из триггера.

### 9.10. Исправления по security review Фазы 1 (2026-11-18, не задеплоено)

| # | Находка | Что сделано | Тесты |
|---|---|---|---|
| H1 | Регистрация киоска по одному платформенному `KIOSK_ENROLLMENT_CODE`: сотрудник компании B, зная код, мог зарегистрировать киоск в компанию A (id филиалов отдаёт публичный `/api/companies/resolve`) | Миграция `008_company_kiosk_enrollment`: `companies.kiosk_enrollment_code_hash` (SHA-256 hex, check-формат); `src/utils/kioskEnrollmentCode.js` (8–128 символов, хэш, constant-time сравнение). Регистрация: `company_code` + код **этой** компании либо staff-bearer той же компании (из БД). Env-код — только для дефолтной компании, пока она единственная и без своего кода; при ≥ 2 компаниях компания без кода — только через staff. Установка/ротация: `PATCH /api/platform/companies/:id { kiosk_enrollment_code }` (`null` — сброс) и `PUT /api/kiosk/enrollment-code` (network-роли своей компании). Код и хэш не возвращаются (только `has_kiosk_enrollment_code`) | `kioskCompanyEnrollment`, `kioskCompanyRegistration`, `migrationRunner` |
| H2 | `queueStatus` / `cancelQueue` (`/api/monitor/queue/:id/*`) искали `queue_entries` по id без компании | Фильтр `company_id` = компания киоска/staff; без токена (legacy) — только пока компания одна, иначе `401 KIOSK_TOKEN_REQUIRED`. Гейт второй компании (9.9) требует `KIOSK_AUTH_ENFORCE` | `kioskQueueCompanyScope`, `multiCompanyGate` |
| M1 | Fallback триггера на компанию №1 маскирует пропущенный `company_id` | Гейт: вторая компания только при `app.tenant_strict = on` (9.9) | `multiCompanyGate` |
| M2 | `legacyDefaultCompanyId` кэшировал «компания одна» на 60 с — после создания второй ещё минуту работали legacy-fallback-и | Кэш удалён (запрос на каждый вызов), `resetLegacyCompanyCache` удалён. В `utils/tenant.js` кэшей нет | `legacyCompanyNoCache` |
| M4 | Staff-логин без `company_code` всегда шёл в дефолтную компанию | Только пока компания одна (`countCompanies` на каждый вход), иначе `400 COMPANY_CODE_REQUIRED`. dash — ручной пункт гейта (9.9) | `companies`, `companyLogin` |
| L3 | Socket-тикет киоска (15 мин) не перепроверял статус компании | Выдача тикета — `403 COMPANY_SUSPENDED`; handshake (`server.js`) — `kioskRegistry.verifySocketKiosk`: киоск существует, филиал совпадает, компания `active`, иначе `KIOSK_SOCKET_REVOKED` (+1 запрос на подключение киоска) | `kioskSocketCompanyStatus` |
| L4 | Kiosk-app: кэш каталога услуг (с ценами) — один ключ на устройство | Ключ `cached_service_catalog_v3:<companyId>:<branchId>`, scope читается из сохранённых компании и филиала; без филиала не кэшируется; старый `…_v2` не читается; смена филиала (`saveSelectedBranchId`) и компании удаляют все каталоги | kiosk `service_local_data_source_test`, `kiosk_repository_impl_test` |
| L5 | `barbers.updateEmployee` (и archive/restore) писали `users`/`barbers` по id без компании | `.eq('company_id', <компания актора>)` на update `users` и при загрузке записи для archive/restore; `company_id` явно в upsert `barbers`; без компании актора — `403 COMPANY_REQUIRED`; `is_on_shift` при логине — с фильтром компании. Остальные update `barbers` по id (перерыв, авто-офф смены, смена филиала) — по id **самого** сотрудника из проверенного токена | `employeeWriteCompanyScope` |

**Принятые риски (до Фазы 5):**
- **M3** — marketplace-клиенты глобальны (`marketplace_clients`, `status_point_transactions` без `company_id`, 9.4): `status_points` копятся по всем компаниям, поэтому визиты в компанию B поднимают уровень кэшбэка клиента в компании A (пороги уровней у каждой компании свои, баллы общие). Решается выбором варианта A/B/C (3.2) в Фазе 5.
- **L1** — `POST /api/companies/resolve` позволяет перебором узнать коды компаний и их филиалы (rate-limit 30 / 15 мин на IP, одинаковый 404). После H1 знание филиала само по себе не даёт зарегистрировать киоск. Смягчение позже: длинные неугадываемые коды, капча или токен приложения.
