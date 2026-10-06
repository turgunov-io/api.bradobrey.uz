# Changelog

## 2026-10-07

- Replaced paid Telegram Gateway delivery with the ordinary Telegram Bot API.
- Added five-minute deep-link onboarding, secret-protected webhook handling,
  unique Telegram bindings, six-digit HMAC-hashed OTPs, expiry, five attempts,
  60-second cooldown, and five-per-hour phone rate limiting.
- Wired `marketplace_telegram_auth.sql` into `db:marketplace:apply`.

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
