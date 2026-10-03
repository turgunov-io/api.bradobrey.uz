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

## OTP `0000`

Статус: **ACCEPTED TEMPORARILY**, но **RELEASE BLOCKER**. На текущем этапе не считается дефектом. Production должен fail-fast при fixed/missing SMS configuration; OTP не должен попадать в response/logs и должен иметь распределённую защиту от перебора.

## Границы проверки

Проведён статический security review и безопасные локальные проверки. Live API attack, production DB и destructive pentest не выполнялись. После исправления P0 требуется security regression loop: fix → review → controlled pentest → retest → resolution.
