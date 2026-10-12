# Project memory

- For Statistics/History authorization, an empty `user_permissions` result on `admin`/`admin_network` means no per-user permissions were provisioned and resolves to the full admin preset; non-empty rows remain explicit overrides.

## Долговременные факты

- Backend использует Express, PostgreSQL и Socket.IO; Marketplace и kiosk объединены через legacy `queue_entries`.
- В queue Marketplace сейчас кодируется как `source='site'`, а в marketplace booking используется `MARKETPLACE`. Это текущая совместимость, но контракт нужно нормализовать и документировать.
- Group booking реализован транзакционно; single booking на 2026-10-03 неатомарен.
- Payment completion/ledger и cashback settlement semantics также неатомарны и не соответствуют финансовой модели ТЗ; не доверять существующим отметкам `DONE` без DB integration evidence.
- Marketplace migration хранится в `db/postgres/marketplace_tz_compliance.sql`; фактическая применённость в runtime DB не подтверждена.
- Универсальный OTP `0000` удалён из backend; phone auth проходит через
  собственного Telegram Bot с одноразовым deep-link onboarding.
- `.env` сейчас игнорируется, но ранее был в Git history. Не хранить секреты или их значения в документации.
- `firebase-service-account-new.json` локально игнорируется и на момент аудита не отслеживался Git.
- Существующий корневой `MARKETPLACE_TZ_AUDIT.md` переоценивает atomicity single booking/cashback и push delivery; актуальный аудит находится в `.project/API_TZ_COMPLIANCE_AUDIT.md`.
- Канонический активный queue contract для Barber и Kiosk: `waiting`, `called`, `swapped`, `in_progress`. `cancelled`, `rejected`, `transfer_pending`, `completed`, `no_show`, `not_in_time` не должны попадать в клиентскую активную очередь или ETA.
- Kiosk availability не должна выводиться из нулевого ETA: authoritative `is_available` истинно только для active/on-shift барбера без active queue. Незавершённый `in_progress` всегда блокирует доступность и даёт минимум 1 минуту ETA даже после превышения плановой длительности.
- Полная цепочка назначения queue entry читается из `queue_status_events` и `queue_transfer_events` через `/api/barbers/queue/:id/barber-history`; ответ намеренно не содержит client PII или transfer reason.
- Service edits после старта поддерживаются через `edit-before-complete` (`service_ids`/`add_service_ids`) и общий queue PATCH; ответы содержат services/total duration/total price и публикуют `queue_updated`.
- No-show endpoint owner-scoped, status-guarded и идемпотентный; успешные явные и автоматические no-show transitions публикуют `queue:update`.
- Active Barber `GET /api/barbers/queue` возвращает PII-free `transfer_history` с именами from/to барберов, потому что Barber UI строит цепочку назначений прямо из queue item. `not-in-time` использует те же owner/status/concurrency/idempotency/realtime гарантии, что и no-show.
- Канонический рейтинг сотрудников — `employee-quality-v1` в `src/services/employeeQuality.js`. Revenue не является ranking key; suspicious сравнивается до productivity; generic legacy cancellations нейтральны.
- `queue_quality_assessments` хранит completion snapshots, а `queue_quality_plan_snapshots` — неизменяемые версии service-duration evidence. Backfill всегда `approximate` и не даёт official rank. Live completion без start/service snapshot также `approximate`.
- Quality migration stamps `started_at`/`finished_at` with PostgreSQL `now()` on transitions into `in_progress`/`completed`; client timestamps cannot influence v1 classification or period inclusion.
- Plan snapshot versions фиксируют timestamp и controlled reason; actor пока `NULL`, пока queue service-edit routes не переведены на authenticated transactional attribution.
- Statistics/History используют DB `user_permissions` как authoritative source, включая пустой набор. Разрешение review отделено: `statistics.quality.review`.
- Quality/statistics permissions авторизуются только по `user_permissions`, а login/me всегда возвращают этот authoritative набор. Для пользователей, существовавших до rollout, есть одноразовый marker-protected role-compatible backfill; после marker ручной отзыв права не восстанавливается повторным schema run. Новые пользователи получают явный набор через административный workflow.
- Audit tables сохраняют raw UUID без FK cascade/SET NULL. Plan/review/status events append-only, а completion assessment разрешает менять только review projection fields.
- Status routes пока не передают достоверного actor/reason в одной транзакции; поэтому новые generic cancellation events намеренно остаются `actor_type=unknown` и не считаются employee failures.
- В схеме нет `network_id`; `statistics.read.global` допустим только при single-network-per-database deployment.
- `barbers.is_active` используется для короткого перерыва/availability и не является кадровым статусом; eligibility качества зависит от `is_archived`, а не от `is_active`.
- Manager Statistics и suspicious Notifications обязаны предпочитать persisted `queue_quality_assessments`; отсутствие assessment допускает только явно `approximate` runtime fallback по текущему каталогу.
- Generic queue PATCH не может менять terminal status, услуги или payment method и использует compare-by-previous-status guard. Повтор того же terminal status — read-only idempotent no-op. Audited employee/branch hard deletion блокируется; используйте archive/deactivate.
- Dedicated queue completion допускает только `in_progress → completed`; повтор `completed` остаётся idempotent recovery path, а DB update обязательно сравнивает ранее прочитанный status, чтобы не перезаписать конкурентный terminal transition.
- Assessment review projection обновляется только при наличии matching append-only review event. Для production всё равно требуется отдельная migration/owner DB role с `GRANT/REVOKE`, чтобы HTTP runtime role не владел audit objects.

## Проверенные команды (2026-10-03)

- `npm test`: 46/46 pass.
- `npm run test:integration`: test skipped без `MARKETPLACE_INTEGRATION=1`.
- `node --check`: 106 JS-файлов pass.
- `npm run build`: no-op, не является quality gate.
- `npm audit --omit=dev`: the current local install reports 27 vulnerabilities
  (2 critical, 17 high, 7 moderate, 1 low). This remains an existing
  dependency-release risk and was not auto-fixed because the suggested forced
  upgrades include breaking PM2/Nodemailer changes.
- App load дошёл до DB и получил authentication failure; живое поведение схемы не проверено.

## Проверенные команды (2026-10-04)

- `npm test`: 70/70 pass, включая employee-quality boundary/ranking/permission/migration tests, authoritative session permissions, one-time permission provisioning, persisted-notification snapshot mapping, generic terminal PATCH integrity и dedicated completion CAS/terminal tests.
- `node --check`: employee-quality, statistics/history integration files pass.
- Миграция подготовлена и включена в `scripts/apply-schema.sh`, но не применялась: безопасная staging PostgreSQL не предоставлена.
- Telegram marketplace auth uses the ordinary Bot API under
  `/api/auth/telegram/*` (with marketplace-prefixed aliases). Linking uses a
  five-minute opaque deep-link token; the mobile request stores only profile
  names/referral metadata. `/start` presents Telegram's `request_contact`
  button, verifies `contact.user_id === message.from.id`, and then issues a
  six-digit HMAC-hashed OTP. OTPs expire after 60 seconds, allow five
  attempts, and use progressive 60s/2m/5m/15m/24h cooldowns. Telegram
  user/chat bindings are unique per marketplace client.
  Runtime verification requires the additive migration and Bot credentials
  outside Git. The new flow is implemented in the local checkout but not yet
  deployed to production.
- Audit 2026-10-07: the phone flow contains no Gateway/MTProto calls; webhook
  requests require `TELEGRAM_WEBHOOK_SECRET`, and duplicate `/start` delivery
  is idempotent. Local PostgreSQL connectivity still needs staging verification.
- Audit 2026-10-06: legacy backend `/api/marketplace/auth/phone/*` endpoints no
  longer issue or verify OTP and fail closed with `TELEGRAM_AUTH_REQUIRED`;
  Bot `/api/auth/telegram/*` is the only phone OTP path.
- Audit 2026-10-06: local PostgreSQL connectivity could not verify the Telegram
  auth tables because the configured `bradobrey_user` password was rejected.

## Проверенные команды (2026-10-07)

- `npm test`: 83/83 pass, including Bot onboarding, hash-only OTP, webhook
  idempotency, verification reuse protection, and Bot/Gateway contract checks.
- `node --check`: touched auth, Bot service, router, app, and migration runner
  files pass.
- `npm run build`: pass; configured project build is a no-op.
- `npm run test:integration`: skipped because `MARKETPLACE_INTEGRATION=1` and
  valid staging PostgreSQL credentials were not provided.
- `npm audit --omit=dev --audit-level=high`: existing install reports 27
  vulnerabilities; no forced dependency upgrades were applied.

## Проверка production Telegram OTP (2026-10-07)

- Live `https://api.bradobrey.uz/api/marketplace/auth/telegram/request-code`
  возвращает старый `TELEGRAM_NOT_CONFIGURED` (503), а live
  `/api/integrations/telegram/webhook` возвращает 404. Текущий checkout уже
  содержит Bot API flow и этот webhook route, поэтому production runtime не
  синхронизирован с checkout.
- В локальном production `.env` отсутствуют
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` и
  `OTP_HASH_SECRET`; значения в память не записывать. Без Bot credentials
  нельзя безопасно выполнить `getMe`, `setWebhook` или реальный smoke test.
- Public health проходит через nginx; DNS `api.bradobrey.uz` разрешается в
  `95.46.96.213`. SSH-проверка с доступным ключом для `root`, `ubuntu` и
  `admin` отклонена, поэтому live PM2/.env/nginx/DB проверить и перезапустить
  из этого checkout невозможно. Read-only PostgreSQL check также отклонён
  production DB ошибкой `28P01`.
- Удалён legacy stdout-log email OTP из
  `src/models/marketplace/auth.js`; Telegram flow уже не логирует token, OTP
  или полный request headers.

## Проверка no-show settings (2026-10-11)

- `PATCH /api/marketplace/admin/settings/no_show_restrictions` принимает `{ value: { enabled, automatic, first_violation_minutes, second_violation_minutes, third_plus_violation_minutes, lookback_days } }`; длительности хранятся в минутах и должны быть JSON-числами.
- Dashboard no-show composable должен передавать Bearer auth header; `skipAuth: true` несовместим с settings controller, который требует JWT роли `admin`/`admin_network`.
- Backend validator отклоняет лишние поля и строковые числовые значения для no-show settings.
- PostgreSQL integration verification была недоступна: `127.0.0.1:5432` отказал в соединении 2026-10-11; записи в БД не выполнялись.
- Production compatibility: the settings controller discards only legacy `updated_at` metadata for `no_show_restrictions` before strict validation, so cached older Dashboard bundles do not fail with 400; arbitrary fields remain rejected.

## Исправление no-show блокировок (2026-10-11)

- Причина отсутствия блокировки: production не содержал таблицу
  `marketplace_no_show_violations`, а сервис пропускал ограничение при ошибке
  отсутствующей миграции; автоматические пути очереди также не вызывали сервис
  регистрации no-show.
- В production создана только additive-структура
  `marketplace_no_show_violations` и индекс по клиенту/дате; существующие записи
  не изменялись. Настройка `no_show_restrictions` активна.
- Автоматические no-show пути теперь регистрируют нарушения так же, как ручной
  endpoint. Создание marketplace-бронирования проверяет `blocked_until`.
- Backend PM2 `BRADOBREY-BARBER` перезапущен и online; dashboard и остальные
  модули не перезапускались.

## Employee Quality v1 audit (2026-10-11)

- `GET /api/statistics/employees` exists and rejects anonymous requests with 401. On 2026-10-11 the additive Employee Quality schema and permission backfill were applied idempotently in production; verification reported `review_events=0` and the API process was restarted.
- Ranking tie-breaks now follow the v1 contract: suspicious state/count/rate, trusted completions, then absolute employee-failure count; revenue and neutral outcomes remain non-ranking fields.
- Aggregate failures now log a safe diagnostic object server-side and return a stable `EMPLOYEE_QUALITY_LOAD_FAILED` code without exposing SQL details. Production API and dashboard smoke checks completed after deployment; authenticated ranking data still requires a real user session for end-to-end verification.
- On 2026-10-11 a production 500 was traced to `loadDataQuality()` binding five PostgreSQL parameters for a query using four placeholders; the extra failure-reasons parameter was removed, covered by a regression assertion, and deployed with an API-only restart.
# Barber login geolocation control (2026-10-11)

- Added additive, unapplied migration `db/postgres/barber_location_control.sql` for per-branch location policy and PII-minimized login audit events.
- Barber/super-barber login now requires fresh location, rejects stale/low-accuracy/mock data, verifies the server-side assigned branch and radius, records an event, and creates outside-radius notifications. Unassigned barbers fail closed.
- No production deployment or migration was performed in this task.

# Production geolocation verification (2026-10-11)

- `test1` is assigned to `Главный филиал` (`c6ec78aa-78c7-4b78-a0f3-9e538e19e54c`); the mobile-selected branch is not authoritative for barber login.
- Configured that branch with latitude `41.3151186`, longitude `69.3292591`, radius `1000m`, enabled. A real production login returned HTTP 200 and recorded an `inside_radius` event with accuracy `11.02m`.
- API geolocation audit passed: migration indexes exist, PM2 is online, health is 200, and the server remains fail-closed for missing configuration/stale/mock/low-accuracy/out-of-radius input.
- The admin-only location-events response now includes the recorded entry coordinates and configured branch coordinates for Verifix map rendering; mobile login responses and public endpoints remain unchanged.

# Barber login before branch location rollout (2026-10-12)

- Barber/super-barber login now skips geolocation when the assigned branch has no enabled `branch_locations` policy, so branches can be onboarded before coordinates are configured.
- Enabled branch location policies still require a current location and preserve stale/accuracy/mock/radius validation and audit notifications.

# Active employee branch context (2026-10-12)

- `users.branch_id` and `barbers.branch_id` remain the permanent/default assignment; they are no longer overwritten by employee login or shift start.
- `db/postgres/employee_branches.sql` adds `employee_branch_access` (legacy assignment plus explicit deny rows) and `employee_active_branches` (one persisted current work branch and shift state per employee).
- Employee login accepts `branch_id`. With multiple active branches and no selection it returns `409 BRANCH_SELECTION_REQUIRED` with branch metadata; inactive or explicitly denied branches return `403 BRANCH_ACCESS_DENIED`.
- JWT `branchId`, Verifix events, kiosk visibility, and marketplace booking validation use the active branch. Apply the SQL migration before deploying the API changes; old single-branch data remains compatible through the legacy fallback.
- `POST /api/barbers/me/branch` validates access server-side, switches the active context, and records branch-specific shift boundaries. `/api/barbers/me` also returns available branches and period statistics with queue revenue, services, shifts, worked minutes, and separate finance snapshot totals/payouts by branch.

# Cross-branch selection correction (2026-10-12)

- The initial implementation incorrectly treated active `employee_branch_access` rows as the complete allow-list. Because the additive backfill creates only the legacy `users.branch_id` row, a barber permanently assigned to A could not select active branch B.
- `listEmployeeBranches` now returns active branches by default and excludes only branches with an explicit inactive access row. This preserves server-side denial and closed-branch checks without making the legacy home row a manual prerequisite for every temporary workplace.
- Added `test/employeeBranchSwitch.e2e.test.js`: an isolated no-production-data contract covering login selection, persisted active branch, kiosk visibility, branch-scoped booking/shift IDs, switching back, inactive branches, and explicit denial.
- The employee directory now joins `employee_active_branches`; branch-filtered admin lists match either permanent `branch_id` or current `active_branch_id`. The API exposes both fields so UI display does not require rewriting the permanent assignment.
