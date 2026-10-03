# Аудит API на соответствие ТЗ маркетплейса

Дата: 2026-10-03  
Объект: `D:\api.bradobrey.uz`  
Итог: **NOT READY FOR RELEASE**

## Правила оценки

- `IMPLEMENTED` — требование подтверждено кодом и доступными тестами.
- `PARTIAL` — основа есть, но поведение неполное либо не подтверждено runtime-проверкой.
- `MISSING` — требование отсутствует или реализация не найдена.
- `BLOCKED` — статически реализация видна, но среда не позволила проверить её фактическую работу.

OTP `0000` не считается дефектом текущего этапа по прямому указанию владельца. Для production это обязательный release gate: случайный одноразовый код, SMS-провайдер, запрет fallback, отсутствие кода в логах и распределённые лимиты.

## Сводка соответствия

| Область ТЗ | Статус | Результат |
|---|---|---|
| Телефонная регистрация, имя, язык, referral | PARTIAL | E.164, TTL, одноразовое использование и транзакция phone-flow есть. Нет production SMS; fixed OTP временно принят. |
| Авторизация и роли | MISSING / P0 | Deny-by-default отсутствует; возможна публичная самостоятельная регистрация администратора и merchant. |
| Каталог и карточка барбершопа | PARTIAL | Координаты, рейтинг, очередь и ETA есть. Не найдены фильтры по цене/детям; рейтинг не пересчитывается как взвешенный из отзывов. |
| Единая живая очередь | PARTIAL | Marketplace использует общую `queue_entries`, но публичные kiosk/monitor операции и Socket.IO не защищены. |
| Одиночная запись | PARTIAL / P0 | Создание неатомарно; возможны orphan booking, phantom event и финансовый рассинхрон. |
| Групповая запись | PARTIAL | Лимит 1–4, до 3 услуг и до 180 минут реализован транзакционно. Есть ошибки blocked/off-shift/`transfer_pending`. |
| Блокировки и anti-fraud | PARTIAL | Таблицы и механизмы есть, но `blocked_until` не выбирается при single/group booking и не применяется. |
| Realtime | PARTIAL / P0 | События реализованы, но комнаты Socket.IO не имеют JWT и branch ACL. |
| Push | PARTIAL | Outbox/LISTEN/NOTIFY есть. Нет глобального владения device token и per-token retry/dead-letter. |
| Cashback/referral/loyalty | PARTIAL | Ledger, caps, уровни и referral points присутствуют. Не найдены Frequency/Happy Hours; возврат cashback при отмене может быть пропущен. |
| Комиссия маркетплейса | MISSING | Не найдены origin-классификация NEW/OWN и расчёт ставок 5,5%/2,5%. |
| Онлайн-оплата Payme/Click | MISSING | Способы рекламируются, но gateway session/callback/webhook verification не найдены. |
| Отзывы | PARTIAL | Completed-only, ownership, уникальность по услуге и окно 24 часа есть. Не найден публичный ответ барбершопа и weighted rating. |
| Multi-tenant isolation | MISSING / P1 | Merchant/admin_branch могут получать сетевые отчёты и PII без shop/branch scope. |
| Идемпотентность и аудит | PARTIAL | В новых marketplace flows механизмы есть, но не покрывают неатомарный single booking и legacy endpoints. |
| Production readiness | MISSING | Нет CI, реального build/lint/typecheck gate, DB readiness, полной observability и проверенного graceful shutdown. |

## Критические блокеры P0

### API-01. Публичное создание admin/merchant и административные mutations

Глобальный middleware пропускает запросы без токена: `src/middleware/employeeAccess.js:54-57`. Публичный `POST /api/barbers/register` принимает роль, включая `admin`: `src/routers/barbers.js:15`, `src/models/barbers.js:1608-1652`. Без router-level auth также доступны mutations филиалов, услуг, сертификатов и Marketplace barbershop/merchant: `src/routers/branches.js:8-12`, `src/routers/services.js:11-16`, `src/routers/certificate.js:6-9`, `src/routers/marketplace/barbershops.js:13-19`.

Риск: полный захват административного контура, изменение прайсов/филиалов/финансов и создание merchant-учётных записей.

Требование: централизованный deny-by-default, явный public allowlist, RBAC и branch/shop scope на каждом mutation endpoint.

### API-02. Незащищённый Socket.IO и утечка очереди

`src/server.js:28-48` позволяет подключиться к произвольной branch-room без JWT и ACL. События содержат идентификаторы и имена клиентов (`src/models/barbers.js:995-1024`). Public catalog/kiosk также возвращает стабильные queue/client identifiers и имена.

Риск: наблюдение за живой очередью любого филиала, сбор клиентских данных и использование идентификаторов для последующих атак.

Требование: authenticated handshake, персональные комнаты клиента, branch-scoped комнаты сотрудников, минимальные публичные DTO только с агрегатами/ETA.

### API-03. Одиночная бронь неатомарна

`queue_entries` создаётся отдельно (`src/models/kiosk.js:901-923`), затем отдельно `marketplace_bookings` (`1120-1137`). `booking.created` публикуется до записи person/services/audit и до promo/cashback операций (`1138-1406`). Ошибочные ветки не всегда удаляют marketplace booking.

Риск: orphan `ACTIVE` booking, блокировка клиента правилом одной активной записи, phantom event и финансовый рассинхрон.

Требование: одна PostgreSQL transaction на queue/booking/person/services/origin/payment/promo/cashback/audit; outbox-event только после commit; fault-injection tests для каждого шага.

### API-04. Захват legacy-идентичности сменой телефона

Marketplace profile меняет телефон без OTP (`src/models/marketplace/profile.js:371-398`), а legacy history/cashback связываются поиском клиента по номеру (`profile.js:40-51`, `488-746`). Уникальность проверяется только среди marketplace clients.

Риск: присвоение истории посещений, cashback и персональных данных клиента, чей номер введён в профиль.

Требование: `pending_phone` + OTP нового номера, атомарное подтверждение и стабильная FK-связь marketplace→legacy client вместо строкового поиска по телефону.

### API-05. Публичная загрузка баннера до 5 GB в RAM

`src/routers/marketplace/banner.js:5-20` использует `multer.memoryStorage()` с лимитом 5 GB, а write endpoints не требуют авторизации.

Риск: memory-exhaustion DoS и подмена публичного контента.

Требование: authentication/RBAC, небольшой лимит, потоковое хранение, проверка magic bytes/MIME и безопасный storage.

### API-06. Исторические секреты в Git

`.env` сейчас игнорируется, но присутствовал в истории; один из коммитов прямо отмечает удаление файла с live secrets. Значения секретов в ходе аудита не читались и не выводились.

Риск: старые DB/JWT/SMTP/VAPID/webhook credentials следует считать раскрытыми.

Требование: ротация всех исторических credentials, завершение старых JWT-сессий, очистка истории и secret scan всех refs/mirrors/CI logs.

### API-07. Финансовая модель ТЗ не реализована корректно

Комиссия 5,5%/2,5% отсутствует. `client_barbershop_origins` хранит первый/последний booking, но не immutable origin NEW/OWN и записывается до завершённого визита. Settlement создаётся при начислении cashback, тогда как ТЗ требует `POINTS_COMPENSATION` при списании баллов; payment completion и замена payment rows выполняются неатомарно (`src/models/barbers.js:2605-2655`, `678-705`).

Риск: неверные взаиморасчёты, commission attribution, completed visit без оплаты и несогласованные ledgers.

Требование: согласовать финансовые правила, ввести immutable visit-origin после completion, атомарный payment/loyalty/settlement flow, reversals и reconciliation tests.

## Высокие риски P1

1. `blocked_until` проверяется после SELECT, который это поле не выбирает: `src/models/kiosk.js:572-583`, `src/models/marketplace/groupBooking.js:64-79`.
2. Public kiosk/monitor позволяет регистрировать устройство, создавать и отменять очередь без device auth/branch scope.
3. Один push token может принадлежать нескольким аккаунтам: составной PK `(client_id, token)`, unregister endpoint отсутствует.
4. Merchant/admin_branch получают несегментированные отчёты, телефоны и fraud metadata всей сети.
5. Rate limiter использует `jwt.decode` до проверки подписи, process-local storage и не покрывает legacy login/admin routes.
6. Group booking может выбирать barber без `is_on_shift`; terminal trigger не считает `transfer_pending` активным.
7. Отмена может завершиться без возврата cashback при несовместимой legacy-схеме.
8. Push notification помечается доставленной после успеха хотя бы одного token; другой transient-failed token повторно не обрабатывается.
9. Legacy email verification неатомарна; account/password могут измениться до consume OTP.
10. `npm audit --omit=dev`: 25 уязвимостей — 1 critical, 17 high, 6 moderate, 1 low.
11. Active queue position имеет off-by-one: текущая запись входит в `count(*)`, после чего добавляется ещё `+1` (`src/models/marketplace/compliance.js:64-71`).
12. Single booking не применяет лимиты до 3 услуг и 180 минут; group booking применяет.
13. No-show timer жёстко задан на 10 минут и хранится в process memory; restart теряет timers.
14. Cashback level lookup фактически перекрывается глобальной setting `cashback`; Frequency/Happy Hours и `FLOOR`-округление не реализованы.
15. Daily points cap работает all-or-nothing вместо начисления оставшегося остатка лимита.
16. Reviews допускают legacy review без `service_id`; group review context может выбрать не того участника/barber.
17. Cashback reconciliation вычисляет и перезаписывает wallet snapshot без блокировки ledger/wallet от конкурентных earn/spend.
18. Правило одной активной записи не является общим DB invariant для kiosk и Marketplace; возможно одновременно войти через `point` и `site`.
19. Публичные no-show/not-in-time endpoints позволяют по UUID применить штраф/блокировку без JWT и ownership check.

## Бизнес-функции ТЗ

### Реализовано или в основном реализовано

- Общая очередь `queue_entries` для kiosk и Marketplace; Marketplace сейчас кодируется legacy-значением `site`.
- Group booking в PostgreSQL transaction с emit после commit.
- Проверка лимитов группы: до 4 участников, до 3 услуг на человека, суммарно до 180 минут.
- Active booking, позиции и ETA из общей очереди.
- Lifecycle-события booking/queue/barber/shift/break.
- Review: только владелец completed booking, услуги записи, уникальность, редактирование 24 часа.
- Loyalty ledger, daily cap, уровни, referral first-visit points, cashback settlement/reconciliation foundations.
- Push outbox с PostgreSQL `LISTEN/NOTIFY`, atomic claim и polling fallback.
- Migration runner с transaction, advisory lock и schema preflight.

### Частично или отсутствует

- В ТЗ источник Marketplace должен быть явным. В queue используется `site`, а в marketplace booking — `MARKETPLACE`; нужен единый документированный контракт/normalization.
- Нет реализации комиссии сети 5,5%/2,5% и origin NEW/OWN.
- Payme/Click указаны в каталоге, но реальный платёжный flow и verified webhooks не найдены.
- Не найдены price/kids filters, Frequency bonus и Happy Hours.
- Не найден автоматический weighted rating по отзывам и endpoint ответа барбершопа на отзыв.
- ETA считается несколькими путями не полностью одинаково; speed factor применяется не везде.
- Реальная применённость migration и конкурентные ограничения в живой PostgreSQL не подтверждены.
- Cancellation penalty не соответствует ТЗ: при live queue `scheduled_start_at` обычно отсутствует, но rank/global penalty всё равно списывается вместо правила ETA-to-turn `<=30`.
- Group linkage хранится в БД, но queue DTO барбера не показывает group/booking identity как связанную запись.

## QA и эксплуатация

### Выполнено

- `npm test`: 39/39 PASS.
- `npm run test:integration`: exit 0, но единственный PostgreSQL test SKIPPED (`MARKETPLACE_INTEGRATION != 1`).
- `node --check`: 105 JavaScript-файлов в `src`, `scripts`, `test` — PASS.
- `npm run build`: PASS, но script является no-op и ничего не собирает/проверяет.
- `npm audit --omit=dev`: 25 findings (1 critical, 17 high, 6 moderate, 1 low).

### Не подтверждено

- Приложение загружается, но DB init завершился `password authentication failed`; schema/runtime checks не выполнены.
- Нет CI pipeline, lint/typecheck/coverage gate и OpenAPI contract.
- `/health` не проверяет PostgreSQL readiness.
- Не проверены Socket reconnect, FCM/webhook delivery, PM2 restart, scheduler concurrency и migration на чистой схеме.
- Shutdown не подтверждён как корректное закрытие HTTP, Socket.IO и DB pool.
- `node_modules` игнорируется, но около 6005 файлов каталога остаются tracked в Git.
- Migration runner применяет только два SQL-файла и не применяет catalog/scheduling/transfer/base schemas, от которых зависит runtime; preflight не проверяет trigger/function/column/version/data reconciliation.
- `marketplace_catalog.sql` удаляет legacy/fallback barbershop rows без подтверждённого backup/rollback плана.

## Минимальный release acceptance suite

1. Все admin mutations: anonymous → 401, неверная роль → 403, branch/merchant видят только свой scope.
2. Невозможно саморегистрировать `admin`, `merchant` или иную привилегированную роль.
3. Socket без валидного JWT отклоняется; комнаты ограничены собственным booking/branch.
4. Public catalog/kiosk не возвращают имена, client ID или queue entry ID других клиентов.
5. Fault injection на каждом шаге single booking оставляет ноль частичных записей и ноль событий.
6. `blocked_until` запрещает single и group booking без side effects.
7. Смена телефона невозможна без OTP нового номера и не раскрывает чужую legacy-историю/cashback.
8. Один push token после A→B принадлежит только B; retries и dead-letter проверяются per token.
9. Отмена cashback-брони либо полностью возвращает сумму, либо полностью откатывается.
10. PostgreSQL integration suite на чистой схеме проверяет concurrency/idempotency/group transfer.
11. Production smoke подтверждает readiness DB, FCM, PM2 restart/graceful shutdown и отсутствие fixed OTP.
12. `npm audit --omit=dev` не содержит critical/high findings.

## Решение

В production выпускать нельзя до закрытия P0. После исправлений нужен повторный security review, интеграционный прогон с рабочей PostgreSQL и controlled non-destructive pentest. Текущий `MARKETPLACE_TZ_AUDIT.md` следует считать устаревшим: он переоценивает атомарность cashback/single booking и гарантии push delivery.
