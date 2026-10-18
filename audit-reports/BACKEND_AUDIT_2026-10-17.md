# Backend audit — 2026-10-17

## Scope and method

Read-only review of the current local checkout of `api.bradobrey.uz`: Express routes and middleware, employee/Marketplace admin handlers, financial writes, booking persistence, upload handling, PostgreSQL migration runner, process lifecycle, dependency lockfile, and existing tests. Socket.IO implementation and Socket.IO-specific findings are intentionally excluded at the owner's request. No production database, server, credentials, or third-party systems were accessed. No code or dependency changes were made.

## Executive summary

The current code has several independently actionable release blockers. Most urgent: an unauthenticated caller can provision privileged employees and mutate employee records; finance snapshot writes and Marketplace barbershop/banner management also lack route or handler authorization. The employee directory exposes internal staff data. A tracked environment template contains credential-shaped values whose validity is unknown. Large unauthenticated banner uploads can consume server memory. Booking persistence has a non-atomic kiosk Marketplace path. The current health route is liveness-only, shutdown does not close server/database resources, and the migration runner omits existing schema files.

Local `npm test` passed **108/108**. This is useful regression evidence, not proof that the exposed routes are protected: the current tests do not provide a full unauthenticated mutation matrix. `npm audit --omit=dev` reports 27 advisories total; the report below excludes Socket.IO-specific advisories and distinguishes dependency presence from exploitability. Production deployment SHA, database schema, backup/restore, reverse proxy, and real user journeys remain unverified.

## Findings

### P0 — Unauthenticated employee provisioning and account administration

- **Evidence:** `src/routers/barbers.js:15-16,46-49` mounts employee listing, registration, per-ID update, archive/restore, and delete without route-level authentication middleware. `src/app.js:57` runs `enforceEmployeeAccess`, but `src/middleware/employeeAccess.js:50-57` explicitly calls `next()` when Authorization is absent; it is not an authentication gate. Registration accepts a caller-provided role at `src/models/barbers.js:1975-1993`; `EMPLOYEE_ROLES` at line 22 includes `admin`, `manager`, and `super-manager`; the selected role is inserted at lines 2013-2019. Employee update accepts role, branch, password, and permissions at lines 1394-1479.
- **Impact:** an anonymous caller can create privileged employee credentials and can attempt to change existing employee roles, passwords, branch assignment, permissions, or account status. This is a direct privilege-escalation/account-takeover path if the running database accepts these operations.
- **Fix:** apply fail-closed admin authentication and server-side role plus branch-scope checks to every management operation. Derive allowed role/permissions from the authenticated administrator; do not trust caller-selected privilege fields.
- **Confidence:** confirmed in current route and handler code; live exploitability was not tested.

### P0 — Unauthenticated financial snapshot mutation

- **Evidence:** `src/routers/finance.js:6-8` exposes GET and POST directly. `src/models/finance.js:288-314` validates only branch/period shape, then upserts arbitrary request `payload` into `finance_snapshots`; no auth/permission/scope check occurs in the handler. The optional-token middleware does not reject anonymous requests (see above).
- **Impact:** an unauthenticated caller can overwrite financial snapshot payloads for an arbitrary branch/period, and read snapshots/overview data. This can corrupt dashboard financial figures and expose sensitive business information.
- **Fix:** require authenticated finance permissions on reads and writes, enforce branch scope against server-side identity, validate the payload schema and size, and audit changes.
- **Confidence:** confirmed in current route/handler code; database permissions and actual deployed route state are unverified.

### P1 — Unauthenticated Marketplace barbershop administration

- **Evidence:** `src/routers/marketplace/barbershops.js:13-19` (mounted via `src/routers/marketplace/index.js:13`) exposes create, update, activate/deactivate, delete, and merchant-link operations. The current handler module `src/models/marketplace/barbershops.js` has no authentication/authorization helper or JWT checks; for example, create begins at line 156 and updates branch assignments through `syncBranches` at lines 44-63.
- **Impact:** anonymous users can alter the public Marketplace catalog, activate/deactivate shops, link merchants, and modify branch-to-shop assignments.
- **Fix:** require Marketplace platform admin authorization for creation/removal and merchant linking; restrict shop updates and branch IDs to the caller's authorized tenant/network; perform shop and branch synchronization in one transaction.
- **Confidence:** confirmed from current mounted routes and handler module; production reachability untested.

### P1 — Public staff directory exposes personal and internal data

- **Evidence:** `src/routers/barbers.js:15` serves the directory without an auth gate. `src/models/barbers.js:428-479` loads employee records and permissions; `employeeItem` at lines 411-426 includes login, phone, role, branch and permission information.
- **Impact:** anyone can enumerate staff names, phone numbers, logins, branch assignments, status, and permission metadata.
- **Fix:** split public availability/profile data from the private employee directory; require authenticated, scoped access for internal fields and return a strict field allowlist.
- **Confidence:** confirmed in code.

### P1 — Credential-shaped values in a tracked environment template

- **Evidence:** `.env.example:19,21-22` contains non-empty Telegram bot token, webhook secret, and OTP hash secret-shaped values. `git ls-files --error-unmatch .env.example` confirms the template is tracked. Values are intentionally redacted from this report and tool output.
- **Impact:** if these are live credentials rather than unmistakable dummy placeholders, they are exposed to every repository reader and may permit bot misuse or weaken OTP security.
- **Fix:** credential owner should immediately verify validity out of band; revoke/rotate any live values, replace them with conspicuous placeholders, and assess repository history exposure. Do not copy credential values into tickets, logs, or this report.
- **Confidence:** presence and tracking confirmed; credential validity/ownership not verified.

### P1 — Public banner mutation and memory-exhaustion upload

- **Evidence:** `src/routers/marketplace/banner.js:5-8,15-20` configures `multer.memoryStorage()` with a 5 GiB per-file limit and exposes create/update/delete without auth. `src/models/marketplace/banner.js:76-145,147-284,285-317` performs mutations without authorization checks. The file is ultimately buffered/written through `src/composable/uploadImage.js:50-60`.
- **Impact:** anonymous content replacement/deletion and large multipart uploads buffered in process memory, allowing API memory exhaustion and service disruption.
- **Fix:** protect all mutations with admin auth, set a small explicit file-size limit based on accepted media, validate content by signature, and use bounded disk/object-storage streaming with cleanup.
- **Confidence:** confirmed in code; no load/availability testing performed.

### P1 — Kiosk Marketplace booking persistence is not atomic

- **Evidence:** `src/models/kiosk.js:1220-1312` writes origin, booking, notification, booking-person, service, and audit rows through separate operations, using compensating deletes on some failures. The sequence is not inside one PostgreSQL transaction and cleanup errors can be ignored. The analogous group booking uses an explicit transaction (`src/models/marketplace/groupBooking.js:62-234`).
- **Impact:** transient database failures can leave a queue entry, booking, or notification partially persisted; clients may see inconsistent booking state or repeat a request. PostgreSQL integration/concurrency behavior was not exercised.
- **Fix:** move all database writes into one transaction or stored procedure, commit before dispatching notifications, and enforce idempotency atomically.
- **Confidence:** confirmed from source; production data impact unknown.

### P1 — Health endpoint can report success while PostgreSQL is unavailable

- **Evidence:** `src/app.js:72-80` returns `{status: "ok"}` without querying PostgreSQL or checking required schema.
- **Impact:** monitors and deploy scripts can treat an API with a broken database connection or missing migrations as healthy.
- **Fix:** retain a liveness endpoint and add a readiness endpoint that checks bounded DB connectivity and required schema/version, without leaking database details.
- **Confidence:** confirmed in code; live DB health unknown.

### P1 — Shutdown does not drain HTTP or close PostgreSQL resources

- **Evidence:** `src/server.js:150-167` signal handlers stop in-process schedulers only. They do not close the HTTP/Socket.IO server, drain requests, or call `pool.end()`; `pool` is created in `src/config/postgres.js`.
- **Impact:** deploy restarts can terminate active requests and connections abruptly; shutdown completion and resource release are uncontrolled.
- **Fix:** implement one idempotent shutdown path with readiness removal, HTTP close/drain, scheduler stop, database pool close, and a bounded timeout.
- **Confidence:** confirmed in code; actual PM2 behavior/configuration not verified.

### P1 — Dependency advisories require remediation and reachability review

- **Evidence:** `npm audit --omit=dev --json` on the current lockfile reports 2 critical, 17 high, 7 moderate, and 1 low advisories. Excluding Socket.IO-specific packages, critical advisories include `proxy-addr` in Express's runtime dependency graph and `basic-ftp` under PM2's agent dependency graph; direct runtime packages Multer and Nodemailer also have high advisories. PM2/Nodemon are listed under `dependencies` in `package.json:19-33`, so they are included in production audit output.
- **Impact:** vulnerable code is present in the installed dependency graph. Presence is not proof of reachable exploitability; PM2 agent paths especially require deployment/use verification. The `proxy-addr` finding affects proxy address handling in the Express runtime graph.
- **Fix:** triage advisories by call path and production installation, update affected direct/transitive packages and lockfile, rerun audit and the full regression suite. Move build/developer-only tools to `devDependencies` where operationally correct; treat PM2 upgrade as a compatibility change.
- **Confidence:** audit output confirmed; exploitability and production package graph not verified. Socket-specific advisories are omitted from this finding per requested scope.

### P1 — Schema runner omits existing SQL files and has no version ledger

- **Evidence:** the `FILES` list in `scripts/apply-schema.sh:32-68` does not include `db/postgres/expenses.sql` or `db/postgres/barber_location_control.sql`, both of which create tables. The runner is an ordered list of idempotent scripts, not a versioned migration ledger; it does not preflight every feature's required schema or provide rollback tracking.
- **Impact:** a deployment using this runner can silently lack schema required by expense/location features. Actual production schema may have been provisioned separately, so the gap is not proof those production tables are absent.
- **Fix:** adopt a versioned migration chain with recorded applied versions, dependency/preflight checks, backup and rollback procedure; include every supported schema migration and verify feature requirements before deployment.
- **Confidence:** runner omission confirmed; production schema status unknown.

### P2 — Integration test suite is opt-in; production DB behavior is unverified

- **Evidence:** `test/integration/marketplaceDatabase.integration.test.js:5-7` is gated on `MARKETPLACE_INTEGRATION === '1'`. Existing local suite passed 108/108, but the DB integration suite was not run in this audit. Earlier project notes report local PostgreSQL authentication failure; no production connection was attempted.
- **Impact:** transaction, constraints, migration compatibility, and concurrency properties are not covered by the default test command.
- **Fix:** provision a disposable/staging PostgreSQL CI target, apply migrations from an empty database, run integration/concurrency tests, and record the tested schema revision.
- **Confidence:** confirmed test gate; deployment coverage unknown.

### P2 — Backup and restore readiness not evidenced in project artifacts

- **Evidence:** reviewed project files and operational audit notes do not document a backup schedule, RPO/RTO, or successful restore drill.
- **Impact:** recovery capability cannot be relied upon based on the available project evidence.
- **Fix:** verify the external backup policy and run a documented restore drill against a non-production target. This is an evidence gap, not a claim that no external backups exist.
- **Confidence:** project evidence gap only.

## Verified positive controls

- `npm test`: 108 tests passed, 0 failed.
- Current Marketplace group booking and cashback/points paths inspected in scope use PostgreSQL transactions and uniqueness/locking safeguards in the reviewed code. This does not substitute for database-backed concurrency testing.
- Socket implementation was not re-audited, as requested.

## Remediation order

1. Close anonymous employee provisioning/management, finance snapshot writes, and Marketplace barbershop/banner mutations; protect the staff directory.
2. Verify and rotate any active credential-shaped values in the tracked template; review repository history exposure.
3. Restrict banner/body upload sizes and validate actual content.
4. Make kiosk booking persistence atomic and idempotent.
5. Add readiness and graceful shutdown; repair/version the migration process.
6. Triage and update dependency advisories, excluding Socket.IO work from this requested scope.
7. Run DB-backed migration/integration/concurrency checks in staging and verify backups/restore.

## Remaining verification limits

This report is based on the current local source and dependency lockfile only. It does not establish the exact production commit, PostgreSQL schema/data, secret validity, reverse-proxy configuration, process manager mode, backup state, or real client behavior. Those require read-only deployment/schema evidence or a safe staging environment.
