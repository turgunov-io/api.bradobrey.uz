# Changelog

## 2026-10-15

- Исправлена смена барбера: direct reassignment теперь всегда ownership-scoped,
  а кандидаты учитывают активный временный филиал и свежий presence.
- Добавлены regression contract tests и полный audit trail в
  `audit-reports/barber-switch/20261015-000234/`.
- Runtime PostgreSQL/Flutter/production проверки остаются отдельными release
  gates и не объявляются выполненными без подтверждения.
- Commit `0d8e154` pushed to `origin/main`. Production overlay/restart и
  authenticated smoke заблокированы: SSH к `95.46.96.213` отклонён для
  `root`, `ubuntu` и `admin`; public `/health` 200 подтверждает только liveness.

## 2026-10-14

- Fixed `PATCH /api/barbers/queue/:id/reassign`: an unreachable-code regression
  was causing the documented direct barber reassignment flow to delegate to the
  pending-transfer workflow and return `transfer_pending` instead of moving the
  queue entry. Restored the direct reassignment path and added a regression
  contract test. Full local backend suite: 105/105.
- Added `employee_branches.sql` to the dependency-ordered schema runner so
  active-branch switching is reproducible on new/staging databases.
- Both fixes were pushed to `origin/main` (`9951d89`, `bdc31d7`). Production
  deployment was not performed in this run: SSH access for the documented
  server was rejected for both tested deployment users. Public `/health`
  returned 200, but no new-code or authenticated smoke verification was
  claimed.
- After owner-provided SSH access, deployed only `src/models/barbers.js` to
  `/var/www/api.bradobrey.uz`, preserving the active production worktree and
  all other modules. Backup: `/var/backups/api.bradobrey.uz-barbers-pre-reassign-20261014.js`.
  Restarted only `BRADOBREY-BARBER`; API health returned 200 and dashboard was
  left untouched.

## 2026-10-14

- Follow-up kiosk presence fix: made backend logout atomic across legacy and active-branch rows; narrowed fallback to a genuinely missing presence table. Kiosk now removes a barber immediately on the logout status event and never renders a stale cached barber list after refresh failure. Barber App preserves its session and surfaces an error if server logout is not confirmed. Regression tests added.
- Pushed API `f95a8ac`, Kiosk `5ce8cca`, and Barber App `463a481`. Deployed only the four presence-related API source files to production after creating `/var/backups/api.bradobrey.uz-presence-followup-20261014.tar.gz`; restarted only `BRADOBREY-BARBER`. API health returned 200; API and dashboard PM2 processes remained online. Mobile client changes still need the signed app release/install path.
- Fixed Barber/Kiosk presence consistency: JWT-scoped logout now clears both
  legacy and active-branch shift state, emits branch-scoped status events, and
  kiosk visibility requires fresh on-shift presence. Added the authenticated
  `/api/barbers/presence` heartbeat endpoint and regression coverage.
- Deployed the current API `main` code to production and restarted only `BRADOBREY-BARBER`; dashboard remained online and untouched.
- Verified existing production branch/geolocation schema, PM2 API status, and public `/health` HTTP 200. Created a server-side rollback archive.

## 2026-10-12

- Allowed barber/super-barber login for branches without an enabled `branch_locations` policy; geolocation enforcement remains active for configured branches.
- Corrected cross-branch employee selection: active branches are available by default, while explicit inactive access rows and inactive branches remain denied. Permanent `users.branch_id`/`barbers.branch_id` is not overwritten.
- Added an isolated cross-branch E2E contract test covering login, active branch, kiosk visibility, shift/booking branch IDs, switching back, and denial cases.
- Fixed the admin employee directory to include employees by current active branch and return `active_branch_id` separately from the permanent branch.

## 2026-10-11

- Fixed no-show restrictions for automatic queue closures and stale queue
  cleanup by registering every newly confirmed no-show.
- Added the missing production `marketplace_no_show_violations` table and
  client/date index without modifying existing records.
- Kept the change scoped to marketplace no-show processing; only the backend
  marketplace process was restarted.

## 2026-10-07

- Switched Telegram onboarding to Telegram Contact as the sole phone source:
  mobile sessions store only names/referral metadata, `/start` presents
  `request_contact`, and contact ownership is checked against `from.id`.
- Updated the local Telegram Bot flow to obtain the phone only from Telegram
  Contact after `/start`, issue a 60-second hash-only OTP, and provide
  Telegram's `copy_text` inline button. Added progressive cooldowns and
  registration metadata while preserving existing routes.
- Replaced paid Telegram Gateway delivery with the ordinary Telegram Bot API.
- Added five-minute deep-link onboarding, secret-protected webhook handling,
  unique Telegram bindings, six-digit HMAC-hashed OTPs, expiry, five attempts,
  60-second cooldown, and five-per-hour phone rate limiting.
- Wired `marketplace_telegram_auth.sql` into `db:marketplace:apply`.
- Removed the legacy marketplace email OTP stdout log.

## 2026-10-06

- Replaced the marketplace phone authorization implementation with the official
  Telegram Gateway API. Added `/api/auth/telegram/send-code` and
  `/api/auth/telegram/verify-code`, persisted opaque Gateway challenges with
  cooldown/expiry/attempt limits, and kept the previous request-code route as
  a compatibility alias.
- Removed the MTProto/GramJS dependency and backend `api_id/api_hash` session
  configuration from the phone verification flow.

## 2026-10-06

- Added Telegram MTProto marketplace authorization by phone and Telegram code,
  including optional 2FA password handling, one-time expiring challenges,
  encrypted persistent StringSessions, JWT issuance, and contract tests.
- Added the additive `marketplace_telegram_auth.sql` migration and wired it into
  `scripts/apply-schema.sh`. Telegram credentials belong only in backend `.env`:
  `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and
  `TELEGRAM_SESSION_ENCRYPTION_KEY`.

## 2026-10-05

- Fixed Statistics/History authorization for `admin` and `admin_network` accounts with no `user_permissions` rows: they now receive the full admin permission preset while non-empty explicit permission rows remain authoritative.
- Live smoke verification found that `GET /api/statistics/employees` returns HTTP 501 until the Employee Quality PostgreSQL migration is applied. The API remains fail-closed and does not substitute revenue ranking.

## 2026-10-04

- Login, admin login and `/api/barbers/me` now return authoritative `user_permissions`, preventing Dashboard role fallbacks from disagreeing with API authorization.
- Added a marker-protected one-time permission backfill for pre-existing employee-quality users, including explicit `dashboard.access` for administrative roles; repeat schema runs do not restore later revocations.
- Добавлен server-side `employee-quality-v1`: strict `<50%` classifier, deterministic quality-first ranking, eligibility/data-confidence rules и revenue только как справочная метрика.
- Добавлены защищённые aggregate, PII-free drill-down и versioned/idempotent review endpoints с self/branch/global enforcement и отдельным `statistics.quality.review`.
- Добавлена транзакционная additive migration для immutable plan/completion snapshots, approximate historical backfill, review audit events и status attribution columns/indexes. Audit UUID не удаляются и не обнуляются при удалении operational entities.
- Миграция не выдаёт permissions автоматически: существующий и новый authoritative empty `user_permissions` сохраняется без role-based escalation.
- Legacy Statistics и History routes теперь требуют JWT + authoritative DB permissions; manager/employee legacy scope выводится из актуального DB user/branch, а не из JWT branch claim.
- History и Notifications используют каноническую persisted/classifier semantics; fallback `created_at` для suspicious detection удалён.
- Добавлено 11 employee-quality tests; полный backend suite проходит 57/57.
- Финальный DB review исправлен: `is_active` (перерыв) исключён из eligibility; manager Statistics и Notifications читают persisted assessments, а catalog fallback помечают `approximate`.
- Generic queue PATCH блокирует reopen/change terminal status и использует optimistic status guard; добавлены регресс-тесты всех terminal состояний и race.
- Backfill принимает только реальный `finished_at`; assessment `id/created_at` и review projection защищены trigger-ами, удаления audited employees/branches блокируются, добавлены employee/global event indexes.
- `apply-schema.sh` теперь fail-fast (`set -euo pipefail`). Полный backend suite проходит 60/60.
- Исправлено отображение persisted suspicious assessment в Notifications: canonical `actual_duration_minutes`/`expected_duration_minutes` явно преобразуются в notification DTO, без `undefined`/`NaN` и без подмены текущим каталогом.
- Generic queue PATCH теперь запрещает менять услуги и payment method terminal заказа; повтор того же terminal status остаётся read-only idempotent no-op. Полный suite проходит 64/64.
- Dedicated complete endpoint теперь разрешает переход только `in_progress → completed`, сохраняет completed retry, блокирует все другие terminal/active source states и применяет CAS по исходному status. Полный suite проходит 68/68.

## 2026-10-03

- Kiosk barber availability теперь явно возвращает busy/available state; незавершённый overdue `in_progress` не превращается в свободного барбера и продолжает блокировать ETA.
- Добавлен защищённый PII-free `GET /api/barbers/queue/:id/barber-history` с original → accepted transfers → current chain и status audit.
- Queue service edits после старта валидируют услуги, возвращают `services/total_duration/total_price` и публикуют realtime `queue_updated`.
- No-show transition получил JWT ownership, status/concurrency guards, идемпотентные retries и `queue:update` notifications.
- Focused queue tests расширены до ETA/availability, service edit, no-show и transfer-history contracts; полный suite проходит 45/45.
- Active Barber queue теперь включает ordered PII-free `transfer_history` с from/to barber names; `not-in-time` endpoint защищён ownership/status/concurrency guards, идемпотентностью и realtime notification. Полный suite проходит 46/46.
- Унифицирован active queue contract между `GET /api/barbers/queue` и `GET /api/kiosk/barbers/:branch_id`: `waiting/called/swapped/in_progress`.
- Личная очередь барбера теперь возвращает `swapped`; Kiosk больше не включает terminal/transfer-pending записи в clients и ETA.
- Добавлены endpoint-level contract-тесты очереди; полный backend suite проходит 41/41.
- Проведён полный read-only аудит backend API на соответствие ТЗ маркетплейса.
- Выполнены security, auth/RBAC, queue/booking, DB/migration, loyalty/payment, realtime/push, QA и operations проверки.
- Зафиксированы P0/P1 findings, release acceptance suite и remediation backlog.
- OTP `0000` зарегистрирован как временно принятое исключение только до подключения SMS; для production оставлен обязательным release gate.
- БД и deployment не изменялись.

## 2026-10-11

- Ужесточена валидация marketplace no-show settings: allowlist полей и числовые типы минут/дней.
- Добавлены regression-тесты лишних полей и строковых длительностей.
- Добавлена обратная совместимость со старыми Dashboard bundles: server-owned `updated_at` отбрасывается только для no-show PATCH до allowlist validation.

- Employee Quality v1: исправлен порядок tie-break по количеству подтверждённых ошибок, добавлен стабильный код ошибки агрегата и безопасное серверное диагностическое логирование. Additive production schema migration/backfill применены идемпотентно 2026-10-11; API перезапущен и проверен.
- Исправлен production 500 в `loadDataQuality`: запрос больше не передаёт лишний bind-параметр PostgreSQL; добавлен regression guard и выполнен API-only restart.
# 2026-10-11 — barber login geolocation control

- Added server-side login geolocation verification, branch policy endpoints, audit events, and outside-radius notifications. Migration is prepared but unapplied; production deployment was not performed.

# 2026-10-12

- Fixed employee cross-branch work context: added access and active-branch persistence, branch selection during login, server-side branch authorization, and active-branch-aware kiosk/marketplace booking and Verifix flows.
