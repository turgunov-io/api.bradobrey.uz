# Security audit

Дата: 2026-10-03  
Статус security gate: **FAIL**

## Открытые findings

### SEC-P0-01 — Неаутентифицированное создание администратора и управление системой

- Finding: legacy и Marketplace administrative mutations не защищены deny-by-default; `POST /api/barbers/register` принимает привилегированную роль.
- Severity: Critical / P0.
- Evidence: `src/middleware/employeeAccess.js:54-57`, `src/routers/barbers.js:15`, `src/models/barbers.js:1608-1652`, `src/routers/marketplace/barbershops.js:13-19`.
- Affected Component: staff/admin/merchant accounts, branches, services, certificates, finance, warehouse.
- Recommended Fix: централизованные authentication, RBAC и tenant scope; explicit public allowlist.
- Developer Fix: не выполнен, аудит read-only.
- Security Retest: обязательная role/tenant matrix для всех routes.
- Resolution: OPEN.

### SEC-P0-02 — Исторически раскрытые секреты

- Finding: `.env` ранее находился в Git history и содержал live secrets согласно истории коммитов.
- Severity: Critical / P0.
- Evidence: несколько commits в `git log --all -- .env`, включая commit остановки tracking live secrets.
- Affected Component: все credentials, которые когда-либо хранились в `.env`.
- Recommended Fix: ротация, revoke старых JWT/keys, очистка Git history и сканирование mirrors/CI logs.
- Developer Fix: не выполнен; значения секретов не читались.
- Security Retest: full-history secret scan и проверка невозможности применения старых credentials.
- Resolution: OPEN.

### SEC-P0-03 — Захват legacy-идентичности через смену телефона

- Finding: телефон marketplace profile меняется без OTP, а legacy data связывается по номеру.
- Severity: Critical / P0.
- Evidence: `src/models/marketplace/profile.js:40-51`, `371-398`, `488-746`.
- Affected Component: history, cashback, booking identity и PII legacy clients.
- Recommended Fix: pending phone + OTP; стабильная FK marketplace→legacy client.
- Developer Fix: не выполнен.
- Security Retest: попытка присвоить телефон другого клиента не меняет БД и не открывает его данные.
- Resolution: OPEN.

### SEC-P0-04 — Утечка живой очереди и незащищённый Socket.IO

- Finding: public API/Socket.IO раскрывает имена и стабильные идентификаторы очереди; room join без JWT/ACL.
- Severity: High / P0.
- Evidence: `src/server.js:28-48`, `src/modules/marketplace/catalog/repository.js:110-115`, `218-232`, `src/models/barbers.js:995-1024`.
- Affected Component: realtime queue и данные клиентов.
- Recommended Fix: authenticated rooms, персональный/branch scope, публичный DTO только с агрегатами.
- Developer Fix: не выполнен.
- Security Retest: anonymous не получает PII/identifiers и не вступает в room.
- Resolution: OPEN.

### SEC-P0-05 — Публичный memory upload до 5 GB

- Finding: unauthenticated banner upload использует memory storage с лимитом 5 GB.
- Severity: Critical / P0.
- Evidence: `src/routers/marketplace/banner.js:5-20`.
- Affected Component: API availability и публичный контент.
- Recommended Fix: auth/RBAC, строгий небольшой лимит, streaming storage, magic-byte validation.
- Developer Fix: не выполнен.
- Security Retest: anonymous → 401; oversized/invalid file отклоняется до загрузки в RAM.
- Resolution: OPEN.

## Другие high findings

- `blocked_until` не применяется при single/group booking.
- Public kiosk/monitor позволяет создавать/отменять очередь без device authorization.
- Push token не уникален глобально и не удаляется при logout.
- Merchant/admin_branch не изолированы по tenant в clients/reports/fraud.
- Rate limiter доверяет неподписанному `jwt.decode`, process-local и не покрывает legacy endpoints.
- Legacy email verify неатомарен.
- 25 dependency vulnerabilities, включая 1 critical и 17 high.

## Employee quality security review (2026-10-04)

### EQ-SEC-01 — Statistics/History anonymous and cross-branch access

- Finding: legacy statistics/history routes ранее не имели единой external-API authorization boundary; branch мог поступать из caller input/JWT claims.
- Severity: High.
- Developer Fix: routes требуют JWT, загружают актуального user/branch и authoritative `user_permissions`; self/branch/global и drill-down predicates enforced server-side; authoritative empty permissions deny access.
- Permission provisioning: для существующих до rollout users подготовлен одноразовый marker-protected backfill; повторный schema run не возвращает отозванные права. Новые users требуют явного назначения permission. Login/me возвращают authoritative DB rows, а не role fallback.
- Security Retest: unit/contract permission boundaries pass; live PostgreSQL route matrix pending staging DB.
- Resolution: FIXED IN CODE / STAGING RETEST REQUIRED.

### EQ-SEC-02 — Quality review privilege and concurrency

- Finding: review нельзя безопасно выводить только из manager role; нужны отдельное permission, scope, audit, idempotency и optimistic locking.
- Severity: High.
- Developer Fix: `statistics.quality.review`, no self-review, branch snapshot check, append-only event, expected/resulting versions and idempotency key.
- Idempotent replay binds the canonical review comment in addition to employee/order/state/version; reuse with a changed explanation returns `409`. Assessment projection updates require a matching append-only review event.
- Security Retest: permission/unit contracts pass; concurrent DB test pending staging.
- Resolution: FIXED IN CODE / STAGING RETEST REQUIRED.

### EQ-SEC-03 — Global scope has no tenant identifier

- Finding: схема не содержит `network_id`, поэтому global permission охватывает всю БД.
- Severity: High in multi-tenant DB; Low in dedicated single-network DB.
- Recommended Fix: add immutable network snapshots and include network predicate in every query before multi-tenant deployment.
- Resolution: ACCEPTED ASSUMPTION FOR SINGLE-NETWORK DB / OPEN FOR MULTI-TENANT.

### EQ-SEC-04 — Terminal actor attribution not yet wired to action routes

- Finding: columns/constraints exist, but existing status mutations do not atomically write server-derived actor/reason.
- Severity: Medium integrity risk.
- Developer Fix: unknown/generic events remain neutral; the API never infers employee blame from final `barber_id`.
- Recommended Fix: migrate each terminal action to a shared transaction helper and retest reason spoofing/concurrency.
- Resolution: SAFE DEGRADED MODE / OPEN.

### EQ-SEC-05 — Audit evidence deletion/nulling

- Finding: draft migration used FK `ON DELETE CASCADE/SET NULL`, which could destroy or anonymize the identifiers needed to explain a historical rank.
- Severity: High integrity risk.
- Developer Fix: audit identifiers are stored as raw UUID evidence without delete actions; plan/review/status events reject update/delete; assessment `id`, `created_at`, classification evidence and delete are DB-protected. Review projection updates require a matching constrained event. API hard-deletion paths and a DB trigger reject deleting employees with quality history.
- Security Retest: migration contract rejects cascade/set-null clauses and requires immutability triggers; live PostgreSQL delete/update tests pending staging.
- Resolution: FIXED IN CODE / STAGING RETEST REQUIRED.

### EQ-SEC-06 — Production DB role separation

- Finding: PostgreSQL trigger protections are not a security boundary against a table owner/superuser, which can disable triggers or alter audit objects.
- Severity: High for production audit integrity.
- Developer Fix: application mutation paths are constrained in code and DB triggers; deployment-specific role grants are intentionally not guessed in the portable migration.
- Required Deployment Fix: use separate owner/migrator and least-privilege runtime roles; revoke runtime DDL, trigger control, direct audit-table mutation, and unrestricted function execution as applicable.
- Security Retest: verify the runtime role cannot disable triggers or directly mutate/delete audit evidence, while approved review transactions still succeed.
- Resolution: STAGING/DEPLOYMENT BLOCKER.

## OTP `0000`

Статус: **REMOVED**. Backend больше не принимает и не создаёт универсальный
код; legacy phone OTP endpoints fail closed with `TELEGRAM_AUTH_REQUIRED`.
Phone authentication must use the Telegram challenge/verify flow.

## Границы проверки

Проведён статический security review и безопасные локальные проверки. Live API attack, production DB и destructive pentest не выполнялись. После исправления P0 требуется security regression loop: fix → review → controlled pentest → retest → resolution.

## Telegram authorization

- `TELEGRAM_API_HASH` and `TELEGRAM_SESSION_ENCRYPTION_KEY` are backend-only
  secrets; Flutter receives neither value.
- Telegram challenge identifiers are opaque, hashed before storage, expire, and
  have bounded verification attempts.
- Telegram phone-code hashes and StringSessions are encrypted with AES-256-GCM
  before database storage; they are excluded from logs and API responses.
- Production security retest remains required after applying the migration and
  configuring credentials in staging. No live Telegram account was used locally.

### SEC-007 — Telegram runtime configuration is absent

- Severity: Critical for Telegram login availability.
- Evidence: the backend working `.env` is missing `TELEGRAM_API_ID`,
  `TELEGRAM_API_HASH`, and `TELEGRAM_SESSION_ENCRYPTION_KEY`; a direct service
  config check returns `TELEGRAM_NOT_CONFIGURED` / HTTP 503 semantics.
- Affected component: `src/services/telegramAuth.js` and deployment environment.
- Recommended fix: provision the three values in the target runtime secret
  store, restart the API, apply `marketplace_telegram_auth.sql`, and run a
  controlled Telegram test account flow.
- Status: Open; production secret store and database schema were not verified.

### SEC-008 — Default phone flow bypasses Telegram

- Severity: Resolved in backend; client migration remains a deployment
  dependency.
- Evidence: legacy `/phone/request-otp` and `/phone/verify` now return HTTP 410
  with `TELEGRAM_AUTH_REQUIRED`; they no longer create or verify an OTP.
- Affected component: marketplace client authentication UX and legacy phone
  auth endpoints.
- Recommended fix: provision the runtime secrets, apply the Telegram migration,
  restart the API, and run a controlled Telegram challenge/verify test.
- Status: Backend fixed; Telegram secrets, database migration, restart, and
  end-to-end test remain open deployment steps.
