# Project memory

## Barber order-history audit (2026-10-15)

- Full documented audit: `.project/audit-reports/barber-order-history/2026-10-15-full-audit.md`.
- Confirmed data-loss path: production `queue_entries` had 57 orders for test account `test1`; 16 were created in October 2026 and 41 before October. Backend `GET /api/history/barber` returns the barber-scoped history without a current-month filter, but Flutter `BarberRepositoryImpl._filterHistoryItemsWithValidDates` keeps only `date.year == now.year && date.month == now.month`.
- The same mobile filter is applied to network results, cache fallback, and before rewriting the local cache. Thus refresh permanently replaces the local history snapshot with the current-month subset.
- The audit was read-only against production. No token, password, or production secret is stored here.
- Remediation must first remove the implicit month filter and preserve the complete cache snapshot, then add cross-month/mobile contract tests, stable pagination/deduplication, canonical date semantics, payment-array mapping, and self/branch history authorization tests.
- Live smoke on 2026-10-15 also confirmed anonymous `GET /api/barbers` returns employee-directory metadata (including login/role/permissions fields) because `enforceEmployeeAccess` passes requests without a token and the list route has no dedicated authorization middleware. Treat as P1 security/privacy finding; do not expose response contents in logs or docs.

- Current reassignment contract (2026-10-15): GET
  `/api/barbers/queue/:id/reassign-options` is the only candidate source for
  reassignment; PATCH `/api/barbers/queue/:id/reassign` creates a durable
  `transfer_pending` request and returns `202`. The target accepts or rejects
  through `/api/barbers/queue/transfers/:transferId/{accept|reject}`. The active
  path validates owner, branch, status, nine-hour staleness, and target workspace
  role/availability. Do not restore the legacy immediate handler.

- `PATCH /api/barbers/queue/:id/reassign` is the documented immediate
  reassignment endpoint. A previous transfer workflow change placed
  `return queueTransfers.request(req, res)` before the existing implementation,
  making the direct reassignment code unreachable and returning
  `transfer_pending` to clients that expect an updated queue entry. The direct
  path was restored on 2026-10-14 and is covered by `queueTransfers.test.js`;
  review any future transfer API change against the Barber client contract.
- `employee_branches.sql` must remain in `scripts/apply-schema.sh` after
  `branches.sql`/`barbers.sql`; omitting it makes cross-branch switching fail
  on a fresh database while the code-level contract tests can still pass.
- On 2026-10-14 the reassignment and schema-runner fixes were pushed to
  `origin/main` as `9951d89` and `bdc31d7`. Production overlay/restart was not
  possible because non-interactive SSH to `95.46.96.213` was rejected for both
  `root` and `ubuntu`; `/health` only confirmed the existing public liveness
  endpoint and must not be treated as deployment verification.
- On 2026-10-14, after SSH access was supplied by the owner, only
  `src/models/barbers.js` was overlaid in production. The pre-change file was
  backed up at `/var/backups/api.bradobrey.uz-barbers-pre-reassign-20261014.js`;
  the deployed SHA-256 matched the tested local file. Only PM2 app
  `BRADOBREY-BARBER` was restarted; dashboard stayed online and untouched;
  `/health` returned 200. The production checkout already had unrelated local
  divergence, so no `git pull/reset` was performed.

- For Statistics/History authorization, an empty `user_permissions` result on `admin`/`admin_network` means no per-user permissions were provisioned and resolves to the full admin preset; non-empty rows remain explicit overrides.

- Barber reassignment has one canonical split workflow: GET
  `/api/barbers/queue/:id/reassign-options` returns queue-scoped eligible
  targets; PATCH `/api/barbers/queue/:id/reassign` creates a
  `transfer_pending` request and returns `202`; the target accepts or rejects
  via `/api/barbers/queue/transfers/:transferId/{accept|reject}`. Do not use
  `/api/kiosk/barbers/:branchId` as the reassignment candidate source.
- The active PATCH path validates the queue entry owner, branch, reassignable
  status, nine-hour stale cutoff, target branch/active/archive/shift state, and
  linked workspace role. Production verification still requires deployment of
  the current source, PM2 restart, and application of
  `db/postgres/queue_transfer_history.sql`.

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

# Production API deployment (2026-10-14)

- Deployed the current `main` commit to `/var/www/api.bradobrey.uz` using an archive overlay; `.env`, `node_modules`, and the dashboard directory were preserved.
- Confirmed the four active-branch/geolocation tables already exist in production, so no database migration was run.
- Restarted only PM2 app `BRADOBREY-BARBER`; `bradobrey-dashboard` was not restarted. PM2 reported the API online and `https://api.bradobrey.uz/health` returned HTTP 200.
- Created rollback backup `/var/backups/api.bradobrey.uz-20261014-deploy.tar` on the server. The production Git worktree still contains historical local divergence and was not reset or force-updated.

# Production kiosk socket secret (2026-10-14)

- Generated `KIOSK_SOCKET_SECRET` directly on the API server and stored it only in `/var/www/api.bradobrey.uz/.env`; the value is not recorded in Git or project documentation.
- Restarted only PM2 app `BRADOBREY-BARBER`; the dashboard process was not restarted. A real registered kiosk request to `POST /api/kiosk/socket-ticket` returned HTTP 200 with a ticket.
- Created the pre-change environment backup at `/var/backups/api.bradobrey.uz-env-20261014-kiosk-secret`.

# Barber/Kiosk presence audit (2026-10-14)

- Audit report: `.project/BARBER_KIOSK_SESSION_AUDIT_2026-10-14.md`.
- Presence is duplicated between `barbers.is_on_shift` and `employee_active_branches.is_on_shift`; current `POST /api/barbers/logout` updates only `barbers`, leaving a possible stale active-branch row.
- `GET /api/kiosk/barbers/:branch_id` returns non-archived off-shift employees with `availability_status=off_shift` instead of excluding them. This does not satisfy the product requirement that logged-out/inactive barbers disappear from kiosk.
- No durable heartbeat/TTL was found for unexpected app termination or network loss. `scheduleShiftAutoOff` is defined in process memory but has no call site.
- Barber Flutter treats every HTTP 401 as a hard logout; JWT default TTL is 12h and no refresh flow exists. A 5–10 minute logout cadence requires production 401/nginx/PM2 evidence; it is not explained by the default JWT TTL.

## Barber/Kiosk presence remediation (2026-10-14)

- Implemented JWT-scoped `POST /api/barbers/logout`: it clears both legacy and active-branch shift state, clears in-memory timers, and emits status to both relevant branch rooms.
- Implemented `POST /api/barbers/presence`; Flutter sends it every 30 seconds and on foreground. Kiosk reads only active branch rows with `updated_at` within 90 seconds and excludes off-shift employees.
- Flutter logout now sends a Bearer token. Transient heartbeat network errors are ignored; only an explicit 401 triggers re-authentication.
- First remediation and the atomic logout/API follow-up were deployed on 2026-10-14. Barber App and Kiosk client source fixes are pushed, but remain subject to the normal signed mobile release/install path.
- Follow-up audit found a kiosk-cache defect: expired cached snapshots remained renderable after refresh errors. Kiosk now hides all cached barber cards whenever the snapshot is stale, consumes `barber_status/is_on_shift=false` to remove and persist the barber immediately, then refreshes from API. API logout now uses one transaction for both shift stores; only a confirmed missing presence relation enables legacy fallback.
- Logout UI no longer clears the barber's local session after a failed/missing server logout request; it reports the failure and allows retry. Kiosk regressions and transaction rollback tests were added.
- Follow-up verification: backend `npm test` 104/104; all tests and `flutter analyze` pass in both kiosk and Barber App repositories.
- Follow-up API deployment: commit `f95a8ac`; only the four presence-related API source files were overlaid, the API PM2 process alone was restarted, API health remained HTTP 200, unauthenticated logout correctly returned 401, and both API/dashboard processes were online. Rollback archive: `/var/backups/api.bradobrey.uz-presence-followup-20261014.tar.gz`. No authenticated real-barber logout or kiosk-device end-to-end test was available.
# Barber reassignment audit (2026-10-15)

- Follow-up fix `f3ec201` aligned the durable PATCH recipient check with the
  active-branch presence contract. When `employee_active_branches` exists, a
  target must have a matching branch assignment, `is_on_shift=true`, and an
  `updated_at` within 90 seconds; permanent/home `barbers.branch_id` is no
  longer required for temporary branch work. A legacy direct-branch fallback
  remains only for installations where the additive presence table is absent.
- Production overlay was completed on 2026-10-15: only
  `/var/www/api.bradobrey.uz/src/models/queueTransfers.js` was replaced after
  a backup was saved outside the repository; `BRADOBREY-BARBER` was the only
  PM2 process restarted and remained online. Dashboard was not touched.
- The authenticated end-to-end transfer was not executed because it would
  mutate a live customer queue; production service, syntax, and unauthenticated
  route checks were used instead.

# Manual final price override (2026-10-15)

- `PATCH /api/barbers/queue/:id/edit-before-complete` now permits any positive
  manual amount. The previous comparison against the cheapest catalog service
  was removed; `amount <= 0` is still rejected and a non-empty reason is still
  required.
- Production overlay `dc6a968` replaced only
  `/var/www/api.bradobrey.uz/src/models/barbers.js` after saving a backup
  outside the repository. Only `BRADOBREY-BARBER` was restarted.
- Regression and queue/transfer contract tests pass 23/23. An authenticated
  live edit was not replayed against a customer order; the production API
  process and deployed file hash were verified instead.

- Direct `PATCH /api/barbers/queue/:id/reassign` must be owner-scoped even when
  JWT contains `branchId`; branch scope is not ownership permission.
- Candidate discovery now merges permanent `barbers.branch_id` with fresh,
  on-shift `employee_active_branches` assignments, matching kiosk semantics.
- Audit evidence and limitations are in
  `audit-reports/barber-switch/20261015-000234/`; PostgreSQL integration and
  authenticated production smoke were unavailable in the local run.
- Commit `0d8e154` is pushed to `origin/main`. Production deployment remains
  blocked because SSH to `95.46.96.213` was rejected for `root`, `ubuntu`, and
  `admin`; public `/health` 200 does not prove the new code is deployed.

# Barber session/logout QA audit (2026-10-15)

- Local backend `.env` has `JWT_EXPIRES_IN=12h`; `signUserToken` also defaults
  to `12h`, so the requested 15-hour token policy is not currently configured.
- Flutter `MidnightLogoutService` is wired from `main.dart` and checks the
  first local-device midnight after `auth_session_started_at`; it has no
  dedicated automated tests and uses device timezone rather than explicit
  Asia/Tashkent conversion.
- Flutter clears the session on every HTTP 401, including a 401 from the
  30-second `/barbers/presence` heartbeat. A logout around 30 minutes is not
  explained by the local TTL and needs production 401 source/log evidence.
- Flutter analyzer passed and 46 tests passed. Full findings are in
  `audit-reports/barber-session/20261015-0010/`.

# Barber kiosk session persistence correction (2026-10-15)

- The earlier 90-second heartbeat visibility cutoff was the exact cause of kiosk cards disappearing after app background/force-close, screen lock, network loss, or socket interruption. Kiosk replaces its barber list from the API; the Barber App only touches diagnostic presence every 30 seconds and on resume.
- Corrected the contract to persist `session_id` plus JWT `session_expires_at` in the existing `employee_active_branches` row. The signed JWT `jti`, active branch, database expiry, and account state are checked on protected Barber workspace requests. Logout atomically clears session fields and both legacy and active-branch shift state. Heartbeat no longer controls kiosk visibility.
- `db/postgres/employee_branches.sql` is additive/idempotent for the new columns. It must be applied before deploying this API revision; API/Kiosk production deployment and physical-device validation are not confirmed.
- Barber App no longer starts the local midnight-triggered logout service; the server JWT expiry remains the session limit. Kiosk fetches current state after socket connect/reconnect and rejects cross-branch call events and stale responses.
- Expired rows are cleared by `src/jobs/employeeSessionCleanup.js` on startup and every minute in one SQL statement that ends both active-branch and legacy shift state; it emits a branch-scoped expiry event. Shift/off-shift changes preserve the session fields. Archived employees revoke the active session and disconnect employee sockets.
- Repeated logout with a previously revoked but still cryptographically valid JWT is idempotent and cannot clear a newer login's session. The global employee middleware and route both allow only this safe replay case.
- Kiosk receives terminal session events separately from ordinary status updates. It removes the card/cache only for logout, archive, or expiry and invalidates in-flight API responses so they cannot resurrect a removed card. Socket reconnect triggers a server snapshot refresh.

# Kiosk session-presence regression follow-up (2026-10-16)

- Reconfirmed the historical disappearance cause: kiosk visibility used a 90-second `updated_at` heartbeat freshness cutoff, so background/closed apps and network loss looked like logout. The durable `session_id` + `session_expires_at` correction is already in `main`; no socket `disconnect` handler ends a barber session.
- Kiosk roster projection now keeps visibility tied to a valid, branch-scoped persisted session while preserving the actual `employee_active_branches.is_on_shift` value. This prevents an authenticated off-shift barber from being incorrectly displayed as on-shift/available.
- Added lifecycle regression coverage for minimize/close/screen-off/network loss/socket reconnect/API process restart, idempotent card projection, explicit logout, expiry/revocation/archive, and branch isolation. These are backend state/projection tests; a real tablet and production schema/runtime were not exercised.
- Production deployment completed on 2026-10-16: applied the additive `db/postgres/employee_branches.sql` migration in a transaction, overlaid the session-aware API files, and restarted only PM2 app `BRADOBREY-BARBER`. The API remained online and `/health` returned HTTP 200; dashboard PID was unchanged. Pre-deploy source backup is `/var/backups/api.bradobrey.uz-session-presence-pre-20261016.tar.gz`. Physical kiosk-device and authenticated end-to-end validation remain outstanding.
# Full service/system audit (2026-10-16)

- Consolidated report: `audit-reports/SYSTEM_SERVICE_AUDIT_2026-10-16.md`.
- Local backend suite: 108/108 passed. A background DB-related request logged `ECONNREFUSED 127.0.0.1:5432` but did not fail the suite; PostgreSQL integration was disabled and production schema remains unverified.
- Live `GET https://api.bradobrey.uz/health` returned HTTP 200; this route is liveness-only and must not be used as DB/deployment readiness evidence.
- Critical current-code risks: public `POST /api/barbers/register` accepts caller-selected `admin` role; public Marketplace banner uploads use memory storage and accept up to 5 GiB. Single marketplace booking and financial completion are not fully atomic. Kiosk app does not send the API's supported `idempotency_key`, risking duplicate orders after lost responses.
- Socket.IO room join is protected in current code by JWT/kiosk ticket and branch authorization; prior broad open-room finding is stale for current checkout, but public DTO PII and production rollout need retest.
- `npm audit --omit=dev`: 27 advisories (2 critical, 17 high, 7 moderate, 1 low); fix and retest runtime graph, triaging PM2/tool-only dependency paths.
- No production DB, PM2, proxy, backup/restore, or device journey could be verified. Historical `.env` credentials existed in Git history; current rotation/revocation status is unknown. Do not infer deployment commit from health status.

# Focused backend audit, Socket.IO excluded (2026-10-17)

- Full current-checkout findings and remediation order: `audit-reports/BACKEND_AUDIT_2026-10-17.md`.
- `npm test`: 108/108 passed; no PostgreSQL integration or production access was used.
- Current source confirms unauthenticated employee provisioning/management, finance snapshot writes, and Marketplace barbershop/banner mutations; the staff directory exposes internal fields. Socket.IO was intentionally out of scope.
- The tracked `.env.example` has credential-shaped Telegram/OTP values; validity is unknown and values are redacted in the audit. Verify out of band and rotate if active.
- Kiosk Marketplace booking writes are not atomic. Health is liveness-only; shutdown does not close server/pool; the schema runner omits `expenses.sql` and `barber_location_control.sql`.
- `npm audit --omit=dev` reports 2 critical and 17 high advisories; Socket.IO-specific dependency findings are excluded from the focused report. Production dependency reachability and deployment state remain unverified.

# Telegram bot promotional-message investigation (2026-10-17)

- Screenshots show unsolicited promotional message bubbles in the bot conversation, not Telegram's sponsored UI bar above a chat.
- Current Telegram backend handlers only send OTP and phone verification/onboarding prompts; no ad copy/dispatch path was found.
- A Telegram-token-shaped value exists in tracked `.env.example` history (observed in commits dated 2026-10-07 and 2026-10-14); local `.env` has no `TELEGRAM_BOT_TOKEN`, so active production token comparison is unavailable. Treat the tracked value as exposed, but do not claim compromise proven.
- Investigation and safe containment steps: `audit-reports/TELEGRAM_BOT_AD_SPAM_2026-10-17.md`. Production/Telegram services were not accessed; token revocation and deployment updates remain owner/operator action.

# Barber transfer outcome notifications (2026-10-18)

- Socket outcome notifications target `employee:<from_barber_id>`; `branch:<id>` receives only generic queue refresh. The API stores outcomes and offers `GET /api/barbers/queue/transfers/outcomes` for client recovery.
- The Barber Android client registers FCM tokens at `/api/notifications/fcm-token`. Server delivery reuses `FIREBASE_SERVICE_ACCOUNT_JSON` through Firebase Admin. Never store or print the service credential in project docs/logs.
- Client Android Firebase app config is provided at `C:\project\bradobrey_barber\android\app\google-services.json`; its registered package was verified as `com.bradobrey_pro.uz`, and the debug APK built successfully on 2026-10-18. Real-device FCM delivery remains unverified. Local backend `FIREBASE_SERVICE_ACCOUNT_JSON` is missing or invalid; production configuration is unknown and rollout was not authorized.

# Production transfer notification check (2026-10-18)

- Read-only checks against `https://api.bradobrey.uz`: `/health` returned HTTP 200 (liveness only); existing `/api/barbers/queue/transfers/pending` and `/api/notifications` returned the expected unauthenticated HTTP 401.
- `GET /api/barbers/queue/transfers/outcomes` returned HTTP 404, and an unauthenticated `POST /api/notifications/fcm-token` returned HTTP 404. The Barber transfer outcome recovery and FCM token registration routes are not deployed in the production API currently checked.
- No authenticated employee push token or FCM delivery test was attempted. No production data/configuration was read or changed; the deployed commit and Firebase Admin credential state remain unverified.

# Queue transfer outcome notifications production release (2026-10-18)

- Deployed API notification changes to `95.46.96.213` by reviewed file overlay; the production Git checkout was not pulled/reset. The source rollback archive is `/var/backups/api.bradobrey.uz-transfer-notifications-pre-20261018-212702.tar.gz`.
- Applied the additive `db/postgres/notifications.sql` migration transactionally; verified `public.employee_push_tokens` exists.
- Restarted only PM2 process `BRADOBREY-BARBER` (new PID 1761395). It is online; `bradobrey-dashboard` remained online with PID 1568203.
- Production `/health` returned HTTP 200. The new transfer-outcomes and FCM-token routes returned HTTP 401 without credentials, confirming route registration and auth enforcement (previously 404). No user notification was sent.
- Five changed API JavaScript files passed production `node --check`. Device-level FCM delivery is still pending Barber App rollout/token registration; no authenticated live accept/reject workflow was exercised.

# Verifix schedule audit (2026-10-18)

- Branch schedule UI renders every active row individually. One branch-wide row plus a matching employee-specific override is expected under the documented fallback model, so the two lines per weekday in the report are not automatically duplicate records. Applying the branch week schedule replaces generic rows but deliberately preserves employee rows.
- Correction after checking production source: `findSchedule()` selects `barber_id` and prioritizes matching employee schedules. The prior audit claim that this field was omitted was false; see `audit-reports/verifix-schedule-duplicates/20261018-current-state.md`. No schedule code change or restart was needed for that claim.
- Manual schedule creation inserts unconditionally and the schema lacks a unique constraint, so actual active duplicates within the same scope/day remain possible. API list only includes active entries in the dashboard because the dashboard filters the response client-side.
- A read-only aggregate query of active Chimgan schedules confirmed one branch-default and one employee override on each weekday, with no same-scope duplicates. The six Monday–Saturday personal overrides were subsequently corrected to 10:00–20:00 at the owner's direction; Sunday 00:00–23:00 was preserved.
- Follow-up fix on 2026-10-18: after the owner said “fix it now,” treated the shown 10:00–20:00 form values as the intended personal schedule. Updated its six Monday–Saturday Chimgan rows transactionally to end at 20:00; Sunday 00:00–23:00 and all generic rows were left intact. Added same-day end-after-start validation to API create/update/bulk paths and the Dashboard schedule forms. Backed up the source files/build and prior rows under `/var/backups`; API and Dashboard are online after restart.

# Socket.IO production recheck (2026-10-18)

- Current read-only report: `reports/socket-audit/2026-10-18-production-recheck.md`.
- Public `/health` and Engine.IO polling handshake return HTTP 200; an unauthenticated Socket.IO namespace connection is rejected with `SOCKET_AUTH_REQUIRED`, as designed. This demonstrates reachable transport, not authenticated event delivery.
- SSH to `ubuntu@95.46.96.213` was rejected, so PM2 state, deployed source, and proxy configuration could not be inspected. No authenticated client credentials/device were available; call-event delivery remains unverified.
- Current contract requires kiosk `auth.kioskTicket` from `/api/kiosk/socket-ticket` or employee JWT in Socket.IO auth. A client sending only legacy `branchId` query is rejected. Correlate the affected client’s sanitized `connect_error` code and auth mode before attributing the incident; never collect the credential itself.
- Cross-repo check of `C:\project\bradobrey_barber` confirmed the likely call-notification root cause: Barber App sends its employee JWT, but never emits `join_branch` after connecting. Its branch ID is only in the query string, which the API does not use for room membership. The API therefore puts it in `employee:<id>` while call events go to `branch:<id>`. The app's branch-change helper also sends `branch:<id>` instead of the raw ID and is a no-op for the initially selected branch. Report and safe corrective direction are in `reports/socket-audit/2026-10-18-production-recheck.md`. The Barber App worktree had a pre-existing modified `pubspec.yaml`; it was preserved.
- Local Barber App fix applied at `C:\project\bradobrey_barber\lib\services\barber_socket_service.dart`: join the authorized branch room after each successful connect/reconnect and verify the ack; use raw branch IDs for join/leave; log branch denials; avoid duplicate listener registration across reconnects. This has not been built or released; no tests were run. The pre-existing modified Barber App `pubspec.yaml` remains untouched.

# Barber reassignment presence and midnight session expiry (2026-10-18)

- Reassignment option listing and durable transfer submission both use
  `employee_active_branches.session_id/session_expires_at`, branch, role,
  account, and on-shift state. `updated_at` is diagnostic heartbeat state only
  and must not gate candidate visibility or transfer eligibility.
- Employee login JWT TTL is capped at the next `Asia/Tashkent` midnight (or a
  shorter configured `JWT_EXPIRES_IN`). The persisted expiry follows the token;
  session cleanup clears both shift flags and broadcasts `barber_status`, while
  branch switching preserves the current deadline.
- Production on 2026-10-18 had 162 tracked working-tree changes (mostly
  `node_modules`) and three local-only commits while `main` was two commits
  behind `origin/main`. Saved the tracked patch and a complete Git bundle under
  `/var/backups/api.pre-pull.20261018T183207Z`, then reset to `origin/main`
  `2a3a8bf`; `git pull --ff-only` confirmed up-to-date and the checkout is clean.
  Production `npm test` passed 136/136. Restarted only PM2 app
  `BRADOBREY-BARBER`; API health was HTTP 200 and the dashboard stayed online.
- On 2026-10-18, fixed production `GET /api/barbers/queue/:id/reassign-options`
  failing because the installed PostgREST query builder has no `.not()` method.
  Session IDs are now filtered in JS after the branch/on-shift/future-expiry
  query. Commit `53a1a4a` is on `main`; 136/136 API tests passed locally and on
  production. Production was fast-forwarded, the API PM2 process restarted,
  health returned OK, and its Git checkout is clean.

# Dashboard geolocation notification lookup (2026-10-18)

- `GET /api/barbers/location-events` supports exact `event_id` filtering. Dashboard callers should send the notification's `branch_id` and `data.event_id` together so one clicked warning maps to its precise login event.
- `manager` and legacy `admin_branch` are branch-scoped location administrators. The list endpoint constrains filtered and unfiltered requests to the JWT `branchId`; branch location read/write endpoints apply the same scope.

# Browser Web Push device targeting (2026-10-19)

- Browser push is stored in `push_subscriptions` and uses VAPID/Web Push; `employee_push_tokens` is the separate native Android/iOS FCM path. Existing browser endpoints already provide per-browser identity and must remain independently registered.
- `POST /api/notifications/push-subscription/status` checks a subscription only by the authenticated user ID plus its endpoint. `POST /api/notifications/test-push` may receive an endpoint to target only that owned subscription; omission preserves legacy user-wide sends.

# Production admin permission restoration (2026-10-19)

- The production `admin` account had exactly five `user_permissions` rows from the one-time employee-quality role-compatible backfill. Those rows were treated as an explicit override, so Dashboard and quality/statistics authorization returned only those permissions instead of the role preset. JWTs do not contain permission claims; `/api/barbers/me` reads current rows from PostgreSQL on every request.
- Backed up the target account's permission rows to `/var/backups/bradobrey-admin-permissions-20261019/admin-permissions-before.json` (mode 0600), then removed only those five rows transactionally. Role remains `admin`; the empty set now selects the existing 26-permission admin preset. Non-target permission rows were not modified.
- Production checks confirmed `/api/barbers/me` returns the target admin with an empty explicit row list; Dashboard's existing empty-admin mapping yields all 26 recognized permissions. Authenticated smoke checks for employees, branches, expenses, penalties, notifications, Verifix settings, and global statistics returned 200; unauthenticated protected expenses/statistics returned 401. Expense creation for global admins must use selected `branch_id` because this account has no home branch.

# Owner workflow preference (2026-10-19)

- Make requested project changes in the local repositories and push Git changes when requested/appropriate. Do not deploy, pull/overlay source on production, build there, restart production processes, or otherwise modify production until the owner explicitly authorizes a production deployment in that request.
