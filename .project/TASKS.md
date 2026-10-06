# Задачи

## P0 — release blockers

- [ ] Ввести deny-by-default authentication/RBAC/tenant scope; закрыть self-registration привилегированных ролей и все admin mutations.
- [ ] Ротировать исторические credentials, завершить старые JWT, очистить Git history и выполнить secret scan.
- [ ] Защитить Socket.IO handshake/rooms и убрать client PII/stable IDs из public queue DTO.
- [ ] Сделать single booking одной DB transaction и публиковать outbox event только после commit.
- [ ] Защитить смену телефона OTP нового номера; заменить связь legacy-данных по телефону на стабильную FK.
- [ ] Закрыть banner upload, уменьшить лимит, отказаться от memory storage и валидировать содержимое.
- [ ] Реализовать marketplace origin NEW/OWN и комиссию 5,5%/2,5% либо документированно исключить её из scope владельцем.
- [ ] Убрать Payme/Click из advertised capabilities до реализации verified payment flow либо реализовать gateway/webhooks.
- [ ] Сделать payment completion, payment rows, loyalty и settlement одной атомарной финансовой операцией; исправить POINTS_COMPENSATION при spend/reversal.
- [ ] Ввести общее DB-правило одной активной записи для kiosk и Marketplace.

## P1 — high priority

- [ ] Исправить `blocked_until` в single/group transaction.
- [ ] Ввести kiosk device authentication, branch scope и безопасную cancellation authorization.
- [ ] Сделать push token глобально уникальным, добавить unregister/logout и per-token retry/dead-letter.
- [ ] Исправить branch/shop isolation для merchant/admin_branch reports, clients и fraud alerts.
- [ ] Исправить group handling `is_on_shift` и `transfer_pending`.
- [ ] Гарантировать атомарный cashback refund при отмене.
- [ ] Исправить cancellation penalty по ETA-to-turn и идемпотентный replay отмены.
- [ ] Заменить rate limiter на bounded distributed implementation после verified auth context.
- [ ] Удалить или транзакционно переписать legacy email auth.
- [ ] Обновить production dependencies до отсутствия critical/high audit findings.
- [ ] Исправить active queue position off-by-one, лимиты single booking и durable/configurable no-show timer.
- [ ] Исправить loyalty rate/caps/Frequency/Happy Hours/rounding и review group/service semantics.
- [ ] Добавить locking/versioning в cashback reconciliation.
- [ ] Добавить DB readiness, structured logging/metrics и полный graceful shutdown.
- [ ] Перевести каждый terminal status-changing route на общий DB transaction helper, который записывает server-derived actor/reason вместе со status; до этого employee-failure metric остаётся conservative/zero для generic transitions.
- [ ] Передавать authenticated actor в immutable `queue_quality_plan_snapshots` для service edits after start; текущий DB trigger сохраняет reason/time, но actor остаётся unknown.
- [ ] Добавить `network_id`/tenant boundary в users, branches, quality snapshots и permissions до использования global statistics в multi-network database.

## P2 — completeness and quality

- [x] Унифицировать active queue statuses между Barber и Kiosk и покрыть contract-тестами.
- [x] Сделать Kiosk availability authoritative для overdue `in_progress`, добавить barber transfer-history в active queue/read contract, realtime service edits и надёжные idempotent no-show/not-in-time transitions.
- [ ] Реализовать/уточнить price/kids filters, weighted rating и публичный ответ барбершопа.
- [ ] Реализовать Frequency и Happy Hours либо согласовать исключение из ТЗ.
- [ ] Унифицировать ETA и документировать canonical source mapping (`site` ↔ `MARKETPLACE`).
- [ ] Добавить OpenAPI, CI, lint/typecheck/coverage и PostgreSQL integration environment.
- [ ] Ввести versioned migration chain со всеми зависимыми SQL, полным preflight и backup/rollback для data-impacting шагов.
- [ ] Удалить tracked `node_modules` из Git после чистой воспроизводимой установки.
- [ ] Обновить README, `.env.example`, `MARKETPLACE_TZ_AUDIT.md` и threat model после исправлений.
- [x] Реализовать backend `employee-quality-v1`, immutable completion evidence, protected aggregate/drill-down/review contracts и boundary/permission tests.
- [ ] Применить employee-quality migration в staging, проверить query plans/p95 и выполнить API integration/security matrix against PostgreSQL.
- [ ] Применить marker-protected `employee_quality_permissions_backfill.sql` для существующих пользователей и проверить фактическую матрицу; новые пользователи получают явные permissions через административный workflow. Локальная проверка заблокирована ошибкой PostgreSQL `28P01` (неверные/неактуальные credentials), поэтому rollout ещё не подтверждён на DB.
- [ ] До production создать отдельного owner/migrator и ограниченного runtime DB role; проверить `GRANT/REVOKE`, чтобы runtime role не мог отключать trigger-ы или напрямую писать immutable audit/event tables. Текущая схема не может безопасно угадать deployment-specific role names.

## Текущий статус

Состояние: SECURITY / AUDIT COMPLETE, REMEDIATION IN PROGRESS. Queue status contract исправлен и покрыт тестами; остальные release blockers остаются открытыми.

## Выполнено — Telegram Bot authorization

- [x] Добавлены Bot API deep-link onboarding, `/start`/`/help` webhook,
  unique Telegram binding and compatibility aliases.
- [x] Добавлены hash-only six-digit OTP, expiry, bounded attempts, cooldown,
  hourly rate limit, generic upstream errors and duplicate webhook handling.
- [ ] Применить `marketplace_telegram_auth.sql` в staging и проверить реальным
  Telegram test account; production rollout требует Bot secrets вне Git.
- [ ] Configure and validate `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`,
  and `TELEGRAM_WEBHOOK_SECRET` outside Git.
- [x] Remove the legacy universal `0000` fallback and disable legacy phone OTP;
  backend phone authentication now requires the Telegram OTP endpoints.
- [ ] Verify `telegram_auth_challenges` in the target PostgreSQL database;
  local verification is blocked by DB credentials.
