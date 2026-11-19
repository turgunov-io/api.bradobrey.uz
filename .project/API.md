# API contracts

## Marketplace authentication and registration boundary

- `purpose=registration` may create a new `marketplace_clients` record after
  successful Telegram verification; `purpose=login` may only authenticate an
  existing active record.
- An unknown login phone returns HTTP 403 with
  `{ "error": "USER_NOT_REGISTERED", "code": "USER_NOT_REGISTERED" }` and
  does not insert an account or issue a JWT.
- Authenticated Marketplace profile, compliance, group-booking, and
  `source=site` booking paths verify the JWT subject against the authoritative
  `marketplace_clients` table and reject missing clients with the same code.

## Marketplace reviews

- `GET /api/marketplace/compliance/reviews?booking_id=<uuid>` accepts either
  the Marketplace booking id or one of its legacy `queue_entry_id` values and
  returns the authenticated client's booking-level review, or `review: null`
  when none exists. An existing review includes server-derived `can_edit` and
  `edit_until` fields based on `created_at` and database time. An optional
  `service_id=<uuid>` selects a service-level review. It never trusts a
  client-supplied user id.
- `POST /api/marketplace/compliance/reviews` accepts a rating from 1 to 5 and
  a comment up to 500 characters and creates a review only for an owned
  completed visit. Repeating a review for the same booking/service updates the
  owner's review while it is within the 24-hour edit window; database
  uniqueness remains the final duplicate guard.
- `PATCH /api/marketplace/compliance/reviews/:id` updates only the
  authenticated owner's review within the same edit window. The edit window is
  checked by PostgreSQL time, not client time. Public database failures use
  stable error codes and do not expose SQL/provider details.

## Marketplace error and notification contract

- Marketplace clients should branch on the stable response `code`; `error` is
  retained as a backward-compatible alias. New server errors must not expose
  SQL, provider, stack, or configuration details.
- Global and marketplace catalog handlers now return stable codes through the
  public error mapper. Legacy marketplace model handlers still need migration
  to this mapper; the marketplace router boundary currently normalizes their
  top-level error responses as a compatibility guard.
- Marketplace FCM uses `marketplace_clients.language` and supports `ru`/`uz`/`en`;
  the normalized language is included in FCM data and provider webhook payloads.

## Dashboard expense branch selection

`POST /api/expenses` accepts `branch_id` (or `branchId`) for `admin`,
`admin_network`, and `super-manager`; this is required for global administrators
without a home branch. Other roles continue to use their authenticated branch,
so a request body cannot override their branch scope. Expense dates remain
server-derived.

## Client queue call socket

Marketplace clients can connect to Socket.IO with their existing marketplace JWT in `auth.token` (or `auth.accessToken`). The server verifies the token and confirms the client account is active, then joins only `client:<client_id>`. When the assigned barber calls a queue entry, that client receives `queue.client_called` and `queue:call` with the queue entry and branch identifiers. The event is transient; clients should refresh queue state after connecting or reconnecting. Employee and kiosk branch room access rules are unchanged.

## Barber transfer outcome notifications

- `PATCH /api/barbers/queue/transfers/:transferId/accept` and `/reject` persist one terminal decision. The initiating employee (`from_barber_id`) is the recipient. A duplicate retry of the same decision is idempotent and does not enqueue another result.
- `GET /api/barbers/queue/transfers/outcomes?limit=50&since=<ISO-8601>` returns accepted/rejected transfers initiated by the authenticated employee only. It supports recovery after socket disconnect or app restart; the default window is 24 hours and `limit` is clamped to 1–100.
- A successful decision emits generic `queue_updated` to the branch room and the detailed result event only to `employee:<from_barber_id>`. FCM delivery is separately attempted after commit and cannot roll back the result.
- `POST /api/notifications/fcm-token` requires an employee JWT and `{ "token": "...", "platform": "ANDROID" }` (also accepts `IOS`). A refreshed token upserts ownership; tokens are retained at logout and removed only when Firebase confirms they are invalid. The server needs configured Firebase Admin credentials for delivery.
- Push data uses `type=queue_transfer_outcome` with transfer, entry, result, initiator, target and branch IDs; rejection reason is included only when supplied and is sanitized. Token values and notification content are not logged.

## Employee quality statistics (`employee-quality-v1`)

All routes require a valid JWT and permissions loaded from `user_permissions`; an empty permission set is authoritative after rollout provisioning.
`employee_quality_permissions_backfill.sql` performs a one-time role-compatible grant for users that predate these permissions and records a migration marker. Re-running schema deployment never restores permissions revoked after that marker. New users receive explicit permissions through the administrative workflow.

- `GET /api/statistics/employees` requires `start_date`, `end_date`, and `scope=global|branch|self`. Branch scope also requires `branch_id`. Dates use a half-open Asia/Tashkent interval and ranges over 366 days are rejected. The response is PII-free, ranks the full authorized cohort, binds `scope.employee_id`, and returns stable numeric-cursor pagination metadata. Revenue is non-ranking context only.
- `GET /api/statistics/employees/:employeeId/orders` additionally requires the corresponding History permission and `category=suspicious|employee_failure|unclassified`. Branch checks use immutable assessment/status-event branch snapshots.
- `PATCH /api/statistics/employees/:employeeId/orders/:orderId/review` requires `statistics.quality.review`, History permission, a branch/global scope, `review_state`, `review_comment`, `expected_version`, and an `idempotency_key`. The assessed employee cannot review their own evidence. Stale or conflicting writes return `409`.

Ranking keys are, in order: active suspicious presence, suspicious count, exact suspicious rate, trusted completions, exact attributable-failure rate, and attributable-failure count. Revenue, `no_show`, `not_in_time`, and unattributed/generic cancellations never affect rank. `barbers.is_active` is a short break/availability flag and never affects eligibility. Only non-archived `barber`/`super-barber` completion snapshots with at least 10 classifiable completions, at least 90% coverage, and entirely authoritative live evidence receive an official place.

Manager statistics and suspicious-order notifications use `queue_quality_assessments` when a completion snapshot exists. A missing per-order snapshot is explicitly reported/handled as `runtime_fallback_current_catalog` with `data_confidence=approximate`; it is never promoted to authoritative evidence.

Global scope currently means the whole database. It is safe only while one PostgreSQL database represents one authorized network; see `OPEN_QUESTIONS.md` before multi-tenant rollout.

## Barber/Kiosk queue

### `GET /api/barbers/queue`

Each active, assigned queue item includes ordered `transfer_history`. Every event contains transfer status/timestamps plus `from_barber_id`, `from_barber_name`, `to_barber_id`, and `to_barber_name`. Client identifiers stored in transfer audit rows and free-text transfer reasons are not exposed. This keeps the active Barber queue self-contained; clients do not need a second history request to render the barber path.

Queue transfer outcomes are broadcast to the branch room through `queue:update` with `type=transfer_accepted|transfer_rejected`, `entryId`, `transferId`, `fromBarberId`, `toBarberId`, `barberId`, and `branchId`. Barber clients use `fromBarberId` to notify only the barber who requested the transfer. These events are transient; clients should still refresh queue state after reconnect.

### `GET /api/kiosk/barbers/:branch_id`

Queue-derived fields use only `waiting`, `called`, `swapped`, and `in_progress`.

The response contains only non-archived employees with a persisted
`employee_active_branches` session whose `session_expires_at` is in the
future. Active/inactive and queue availability are displayed as card state;
they do not control authenticated card visibility. Heartbeat age and Socket.IO connectivity do not affect card
visibility. The session survives API restarts and network interruptions, and
is ended by explicit logout, expiry, or administrative/account revocation.
Kiosk clients refetch this endpoint on `queue:update` and after every socket
connect/reconnect.

`is_on_shift` is taken from the persisted active-branch row independently of
session visibility. A valid logged-in barber remains listed when off shift,
with `availability_status=off_shift` and `is_available=false`.

`queue:update` with `type=barber_status` includes `session_ended=true` and a
`reason` only after confirmed logout or administrative archive. Expiry cleanup
uses `session_expired=true`. Kiosk may remove that barber immediately from its
branch-local cache; an ordinary `is_on_shift=false` event is not a session end.

Logout clears both legacy and active-branch shift records in a single
PostgreSQL transaction. The kiosk may use legacy-only fallback only when the
active-presence table is confirmed missing; column, permission, and schema
errors fail closed instead of serving potentially stale legacy shift state.

- `is_available` is the authoritative booking flag. It is `true` only when the employee is active, on shift, and has no active queue entries.
- `availability_status` is `available`, `busy`, `off_shift`, or `inactive`.
- `active_queue_count`, `has_in_progress`, and `current_service_overdue` describe the current workload.
- `estimated_waiting_time` sums planned time for queued entries and remaining time for `in_progress`. An unfinished `in_progress` entry always contributes at least one minute, even after its planned duration elapsed.
- Each client item exposes `estimated_time`, `estimated_remaining_time`, and `is_overdue`.

Queue lifecycle and service edits emit `queue:update` to `branch:<branch_id>` so Kiosk must refetch this endpoint on that event.

### `POST /api/barbers/presence`

Requires the current barber/manager JWT. The active branch is taken from the
JWT; request body branch or employee identifiers are not trusted. The endpoint
refreshes diagnostic `employee_active_branches.updated_at`. A heartbeat does
not create, extend, or expire the login session and does not control kiosk
visibility. Login stores a random signed-session `jti` and the JWT expiry in
the active-branch row. Protected barber workspace routes validate the same
branch, session ID, account state, and expiry against PostgreSQL. Apply the
additive `db/postgres/employee_branches.sql` schema before deploying this API.
Barber/manager login sessions expire at the earlier of the configured JWT TTL
and the next midnight in `Asia/Tashkent`; the server cleanup clears expired
session and shift state and emits a branch-scoped `barber_status` event. Branch
switches preserve the existing session deadline.

### Barber reassignment candidates

`GET /api/barbers/queue/:id/reassign-options` and the transfer request both
require an active branch assignment, on-shift state, allowed workspace role,
active/non-archived account, and an unexpired persisted session. They do not
require a recent heartbeat. Temporary app closure, screen lock, network loss,
or Socket.IO disconnect therefore does not remove an otherwise eligible
barber; logout, session expiry, branch revocation, and shift end still do.

### `GET /api/barbers/queue/:id/barber-history`

Requires a valid barber/manager JWT. Access is limited to the current/previous transfer participants; a branch-scoped manager may read entries from their branch.

The response contains:

- `entry.original_barber`, `entry.current_barber`, and ordered `entry.barber_path`;
- ordered transfer attempts with from/to barber names and timestamps;
- ordered status audit events with the responsible barber.

Client names, phones, identifiers, and transfer free-text reasons are intentionally omitted.

### `PATCH /api/barbers/queue/:id`

Existing queue update contract. `service_id`/`service_ids` are validated before persistence. The response entry also contains `services`, `total_duration`, `total_price`, and `started_at`. Service/payment changes emit `queue:update` with type `queue_updated`. Once an entry is in `completed`, `cancelled`, `rejected`, `no_show`, or `not_in_time`, this generic endpoint cannot change its status, services, or payment method. Repeating the same terminal status is a read-only idempotent response and performs no write. Status writes use the previously read status as a concurrency guard and return `409` after a race.

### `PATCH /api/barbers/queue/:id/edit-before-complete`

Accepted optional fields:

- `service_ids`: replace the service list;
- `add_service_ids`: append unique services;
- `amount` plus mandatory `reason`: set a manual final-price override.

The assigned barber may edit any non-terminal entry, including `in_progress`. A service-only edit clears an older price override and recalculates service total/duration. The response is enriched like the generic queue update and emits `queue_updated`.

### `PATCH /api/barbers/queue/:id/complete`

Only an assigned entry currently in `in_progress` may transition to `completed`. A repeated request for an already `completed` entry preserves the existing idempotent recovery behavior without rewriting queue status. Other terminal states and earlier active states return `409`. The completion update compares the previously read `in_progress` status, so a concurrent cancellation, rejection, no-show, or not-in-time transition cannot be overwritten.

### `PATCH /api/barbers/queue/:id/no-show`

Requires the assigned barber/manager JWT. `no_show=true` permits only `waiting`, `called`, or `swapped` to `no_show`; `no_show=false` permits only `no_show` to `waiting`. Repeating the same target state returns `200` with `idempotent: true`; conflicting terminal states return `409`. A successful transition emits `queue_no_show` or `queue_no_show_reverted` through `queue:update`.

### `PATCH /api/barbers/queue/:id/not-in-time`

Requires the assigned barber/manager JWT. Only `called` or `in_progress` entries may transition to `not_in_time`. Repeating an already completed `not_in_time` request returns `200` with `idempotent: true`; conflicting states return `409`. The update is guarded against concurrent status changes and emits `queue_not_in_time` through `queue:update`.

## Telegram Bot phone authorization

Canonical routes:

### `POST /api/auth/telegram/send-code`

Also available under `/api/marketplace/auth/telegram/send-code`.

Request: `{ "first_name": "...", "last_name": "...", "referral_code": "..." }`.
The phone number is intentionally not accepted from the mobile client. It is
obtained only from the Telegram `message.contact.phone_number` update after the
user opens the deep link and shares their own contact.

If the phone is not linked, response is `{ "requiresTelegramLink": true,
"linkToken": "...", "botUrl": "https://t.me/<bot>?start=...", "expiresIn": 300 }`.
The mobile app opens `botUrl` and the Bot API webhook completes the binding.
If already linked, the backend generates a six-digit OTP and sends it through
the ordinary Bot API. OTP hashes only are persisted.

`POST /api/auth/telegram/link` is an alias of `send-code`.

### `POST /api/auth/telegram/verify-code`

Also available under `/api/marketplace/auth/telegram/verify-code`.

Request: `{ "challenge_id": "...", "code": "123456", "language": "ru" }`.
The legacy `phone` lookup remains only as a compatibility alias; it is not used
by the mobile flow. On success the endpoint marks the Telegram-provided phone verified, persists
the Telegram binding, creates or logs in the marketplace client, and returns
`{ "token": "...", "verified": true, "is_new_user": true|false, "client": {...} }`.

Errors include `INVALID_PHONE` (400), `TELEGRAM_RESEND_TOO_SOON` (429),
`TELEGRAM_HOURLY_LIMIT` (429), `INVALID_CODE` (400),
`LINK_TOKEN_EXPIRED`/`VERIFICATION_SESSION_EXPIRED` (410),
`TOO_MANY_CODE_ATTEMPTS` (429), and `TELEGRAM_CODE_SEND_FAILED` (502).
Link tokens and challenge identifiers are opaque hashes in PostgreSQL; links
and OTPs expire after five minutes, new codes are limited to one per minute
and five per hour per phone, verification has at most five attempts, and
plaintext OTPs are never stored.

### `POST /api/auth/telegram/webhook`

Also available under `/api/marketplace/auth/telegram/webhook` and
`/api/integrations/telegram/webhook`. Telegram sends
`/start <linkToken>` and `/help` updates here. Requests require the
`X-Telegram-Bot-Api-Secret-Token` header matching `TELEGRAM_WEBHOOK_SECRET`.
Duplicate `/start` updates are idempotent. The endpoint always acknowledges a
validly authenticated Telegram update with HTTP 200.

The old `/api/marketplace/auth/telegram/request-code` route remains as an alias
of `send-code` for compatibility. Legacy `/phone/*` routes remain disabled.

The legacy `POST /api/marketplace/auth/phone/request-otp` and
`POST /api/marketplace/auth/phone/verify` endpoints return HTTP 410 with
`TELEGRAM_AUTH_REQUIRED`; they do not create or verify fallback OTPs.
# Employee branch context

`POST /api/barbers/login` accepts optional `branch_id` for workspace employees. When credentials are valid but more than one active branch is available and `branch_id` is absent, the response is `409` with `code: BRANCH_SELECTION_REQUIRED` and a PII-free `branches` array. Branch access is an allow-list (MULTI_TENANCY 0.7): an employee may select their home branch (`users.branch_id` / `barbers.branch_id`) plus branches with an active (`is_active = true`) `employee_branch_access` row; network roles (`admin_network`, `admin`, `super-manager`) may select every active branch **of their company** (MULTI_TENANCY Phase 1). An explicit inactive `employee_branch_access` row is a server-side deny and always wins. A closed/inactive branch or denied branch returns `403 BRANCH_ACCESS_DENIED`.

The selected branch is persisted in `employee_active_branches` and is reflected in JWT `branchId`, `/api/barbers/me` as `active_branch_id`, Verifix events, kiosk employee visibility, and queue bookings. `users.branch_id`/`barbers.branch_id` remain the permanent assignment. Apply `db/postgres/employee_branches.sql` before enabling multi-branch assignments; the migration is additive and does not rewrite permanent assignments.

`POST /api/barbers/me/branch` switches an authorized workspace employee's active branch. If the employee is on shift, the API records a `shift_end` in the previous branch and a `shift_start` in the new branch; historical queue entries and payments remain attached to their original `queue_entries.branch_id`.

`GET /api/barbers?mode=employees&branch_id=...` filters by both the permanent assignment and the persisted `active_branch_id`, so an employee temporarily working in another branch appears in that branch's administrative directory without changing the permanent assignment.
# Barber login location events

- `GET /api/barbers/location-events` accepts optional `branch_id`, `event_id`, and `limit` query parameters. Supplying `event_id` returns the matching event within the supplied branch; branch-scoped `manager` and `admin_branch` tokens are always constrained to their JWT `branchId`, even when `branch_id` is omitted.
- The endpoint requires an authenticated location-administration role. Event lookup is used by Dashboard geolocation warning notifications; callers must use both notification `branch_id` and `data.event_id`.

# Browser push subscriptions

- `POST /api/notifications/push-subscription/status` requires an employee JWT and `{ "endpoint": "https://…" }`; it returns only whether that endpoint is registered to the authenticated user.
- `POST /api/notifications/test-push` optionally accepts the same endpoint in its JSON body. When supplied, delivery is restricted to the subscription owned by the authenticated user and that exact endpoint. Calls without an endpoint keep the legacy user-wide delivery behavior.

# Certificates

- Certificate administration routes require bearer authentication and the
  certificates.manage permission, subject to the existing global-admin role
  preset. Anonymous requests are rejected before database work.
- Marketplace payment-options endpoints return supported payment methods but do
  not expose certificate codes or metadata.
- Certificate redemption in booking uses server-side code/status/expiry/service
  validation. Codes are normalized to uppercase, every requested service must
  be covered, and site bookings using a certificate require idempotency_key.
- The canonical authenticated lookup endpoint is
  `GET /api/kiosk/certificate/:id`; it returns only the minimum data needed by
  the booking client for allowed-service selection. It is not mounted below
  `/api/marketplace`, so clients must not prepend the marketplace prefix to
  this shared kiosk path.
- Certificate-backed queue entries reserve the certificate while their status
  is `waiting`, `called`, `swapped`, or `in_progress`. Booking does not set
  `is_used`. The PostgreSQL lifecycle trigger sets `is_used` only when the
  same queue entry changes to `completed`; `cancelled`, `rejected`, `no_show`,
  `not_in_time`, and cleanup deletes release an unfinished reservation.
- Apply `db/postgres/certificate_lifecycle.sql` (included after
  `certificates.sql` by `scripts/apply-schema.sh`) before enabling this
  certificate booking flow. If the lifecycle columns are absent, certificate
  booking fails closed with `CERTIFICATE_LIFECYCLE_NOT_CONFIGURED`.
- Certificate administration cannot manually set `is_used`; use the queue
  completion lifecycle. Admin list responses expose a derived `status` of
  `active`, `reserved`, `used`, or `expired`.

# Companies (multi-tenancy, Phase 1 step B1)

See `.project/MULTI_TENANCY.md` section 9. One company = one barbershop brand
with many branches. The kiosk and barber apps enter a **company code** first,
then pick a branch of that company only.

## `POST /api/companies/resolve`

No auth. Rate-limited per IP (30 / 15 min, `keyBy: 'ip'`; needs `TRUST_PROXY`
behind a proxy).

Request: `{ "code": "BRADOBREY" }` — trimmed, case-insensitive.

- `200` `{ company: { id, name, code, logo_url, primary_color, currency }, branches: [{ id, name, address }] }` — active branches of that company only, sorted by name.
- `404` `{ code: "COMPANY_NOT_FOUND", error: "Company not found" }` — unknown, suspended **or malformed** code; always the same body.
- `400` `{ code: "COMPANY_CODE_REQUIRED" }` — `code` missing.
- `429` `{ error: "RATE_LIMITED" }` with `Retry-After`.

## `POST /api/kiosk/register`

Body: `{ company_code, branch_id, device_name, enrollment_code? }`.

- `company_code` given: unknown/suspended → `404 COMPANY_NOT_FOUND` (same body as resolve); `branch_id` not of that company, unknown or closed → `403 KIOSK_BRANCH_FORBIDDEN`.
- `company_code` absent (deployed kiosk apps): allowed only while the platform has exactly one company and it is the active default one (warning `[kiosk] ... without company_code` once per process); otherwise `400 COMPANY_CODE_REQUIRED`.
- Enrollment, after the company is resolved (security review H1, migration 008): `enrollment_code` must match **that company's own** code (`companies.kiosk_enrollment_code_hash`, SHA-256, constant-time), or a staff bearer token whose user belongs to **the same company** (DB-checked) and whose branch scope covers `branch_id`; otherwise `403 KIOSK_ENROLLMENT_CODE_INVALID`. Env `KIOSK_ENROLLMENT_CODE` is only a legacy fallback for the default company while it is the only company and has no code of its own (unset there = open, with a warning). With 2+ companies a company without its own code enrolls kiosks via staff only. `409 KIOSK_ALREADY_REGISTERED`.

## `PUT /api/kiosk/enrollment-code`

Staff bearer (`staffAccess.requireStaff`, role/company from the DB); only network roles (`admin_network`, `admin`, `super-manager`) of the caller's own company. Body `{ enrollment_code }` (8–128 chars, trimmed) → `200 { updated: true }`; the code is stored hashed and never returned. Branch roles / no company → `403`; invalid code → `400`.

## `/api/monitor/queue/:id/status`, `/api/monitor/queue/:id/cancel`

Queue entries are looked up within the caller's company (kiosk token → kiosk company and branch). Without a kiosk token (legacy, `KIOSK_AUTH_ENFORCE` off) only while exactly one company exists; otherwise `401 KIOSK_TOKEN_REQUIRED`.
- Success unchanged: `201 { branch_id, kiosk_id, device_token }`.

Kiosk device tokens (`X-Kiosk-Token`) resolve the company via the kiosk's
branch: `req.kiosk = { id, branchId, companyId }`; a suspended company is
`403 COMPANY_SUSPENDED`. `GET/DELETE /api/kiosk/devices` only list/delete kiosks
of the caller's company (another company's kiosk is `404`).

## Staff login: `POST /api/barbers/login`, `POST /api/auth/login`, `POST /api/barbers/admin/login`

New optional body field `company_code`. The user lookup is
`(company_id, login)`; a workspace branch must belong to that company (the
branch list in `409 BRANCH_SELECTION_REQUIRED` is company-only).

- `company_code` unknown/suspended → `404 COMPANY_NOT_FOUND`.
- `company_code` absent → the default company (`companies.is_default`) **only while it is the only company** (counted on every request), warning `[auth] staff login without company_code` — keeps the current barber app and dash (`dash/server/api/barbers/login.post.ts` sends only `login`, `password`, `branch_id?`, `location?`) working until a second company exists. 2+ companies or no default company → `400 COMPANY_CODE_REQUIRED`; default company suspended → `403 COMPANY_SUSPENDED`.
- Response `user` gains `company_id`; the JWT gains `companyId`.

## Staff tokens and company checks (all staff routes)

Staff JWT: `{ sub, login, role, branchId, companyId, jti? }`, HS256 only
(`src/utils/authToken.js`). On every request with a staff token
(`enforceEmployeeAccess`, and the guards in `adminAuth`, `staffAccess`,
`employeeManagement`, `kioskAuth`, statistics/history auth, sockets) the user's
`company_id` and company status are loaded from the DB:

- token `companyId` ≠ DB → `401 TOKEN_COMPANY_MISMATCH`; tokens without `companyId` (issued before B1) are accepted and the company is taken from the DB;
- company suspended → `403 COMPANY_SUSPENDED`; user without company → `403 COMPANY_REQUIRED`;
- `req.tenant = { companyId, isPlatformOwner }`.

Network roles (`admin_network`, `admin`, `super-manager`) now see **every
branch of their company** instead of the whole database (branch scopes,
employee directory, kiosk devices, socket `join_branch`, statistics/history
branch scopes). Socket `join_branch` for a branch of another company answers
`{ ok: false, code: "BRANCH_ACCESS_DENIED" }`.

## Platform owner: `/api/platform/*`

`platform_owner` (no company) manages companies only — no statistics, clients
or company data. With a platform-owner token every other `/api/*` staff route
answers `403 PLATFORM_OWNER_NO_TENANT_ACCESS`. All company routes check the
role in the DB (`403 PLATFORM_OWNER_REQUIRED` otherwise).

- `POST /api/platform/login` `{ login, password }` → `200 { token, user: { id, login, role: "platform_owner" } }`; wrong credentials → `400 Invalid credentials`. Rate-limited per IP (20 / 15 min).
- `GET /api/platform/companies` → `{ companies: [{ id, name, code, status, currency, timezone, logo_url, primary_color, is_default, has_kiosk_enrollment_code, created_at, updated_at }] }` (the enrollment code / its hash are never returned).
- `POST /api/platform/companies` `{ name, code, currency?, timezone?, logo_url?, primary_color? }` → `201 { company }`. **Gate:** `409 { code: "MULTI_COMPANY_PRECONDITIONS", failed: ["KIOSK_AUTH_ENFORCE"?, "TENANT_STRICT"?] }` unless kiosk auth is enforced and `current_setting('app.tenant_strict')` is `on` (MULTI_TENANCY.md 9.9). `code` is stored upper-case, `^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$`; duplicate (case-insensitive) → `409 COMPANY_CODE_TAKEN`; unknown fields → `400`.
- `PATCH /api/platform/companies/:id` — any of `name, code, status (active|suspended), currency, timezone, logo_url, primary_color` (`logo_url`/`primary_color` accept `null`), plus `kiosk_enrollment_code` (8–128 chars → stored as SHA-256 hash; `null` clears it; never returned). Unknown id → `404`; suspending the default company → `409 DEFAULT_COMPANY_SUSPEND_FORBIDDEN`; re-activating a suspended non-default company is subject to the same `409 MULTI_COMPANY_PRECONDITIONS` gate as creation.
- `POST /api/platform/companies/:id/admins` `{ login, password }` → `201 { user: { id, login, role: "admin", company_id } }`. Password 8–128 chars, bcrypt (cost 10). Login taken in the company → `409 LOGIN_TAKEN` (logins are unique per company after migration 007).
- `timezone` (create/patch) must be an IANA zone name (`Area/Location`, `UTC`, `Etc/…`); offsets like `+05:00` and abbreviations like `EST` → `400`. Stored in canonical case.

### Platform owner accounts: `/api/platform/owners`

Allowed for (checked in the DB, the token's role is ignored): `platform_owner`,
or `admin_network` / `admin` whose company is the **default** company
(`companies.is_default = true`) and `active`. Everyone else → `403 PLATFORM_OWNERS_FORBIDDEN`;
no/invalid token or unknown account → `401`. A default-company admin can use
only these two routes — `/api/platform/companies*` stays `403 PLATFORM_OWNER_REQUIRED`.

- `GET /api/platform/owners` → `200 { owners: [{ id, login, created_at }] }` (sorted by login; `created_at` is `null` until migration `009_users_created_at` is applied).
- `POST /api/platform/owners` `{ login, password }` → `201 { owner: { id, login, created_at } }`. Creates a `users` row with `role = 'platform_owner'`, `company_id = NULL`; password bcrypt (cost 10, as company admins). Login 1–64 chars without spaces (trimmed), password 8–128 chars, else `400`. A platform owner with that login exists → `409 LOGIN_TAKEN` (also on a concurrent duplicate via `users_platform_login_uidx`).

# Company data scoping (multi-tenancy, Phase 1 step B2)

See `.project/MULTI_TENANCY.md` sections 9.5, 9.8, 9.9. Response shapes are
unchanged unless listed here.

## Company context for marketplace (ŞAF) endpoints without a booking

`GET /api/marketplace/compliance/loyalty`, `GET /api/marketplace/compliance/restriction`
and `GET /api/marketplace/compliance/referral` (only when the client has no
referral account yet) now take an optional `?branch_id=<uuid>`; the company is
that branch's company.

- `branch_id` absent: the default company is used **only while the platform has
  exactly one company**. With two or more companies, or with an unknown /
  malformed `branch_id` → `400 { code: "BRANCH_REQUIRED", error: "branch_id is required" }`
  — the same contract as `GET /api/loyalty/ranks` and `GET /api/kiosk/certificate/:id`.
- `loyalty`: levels (`loyalty_levels`) of that company.
- `restriction`: `violation_count` counts no-shows at that company with that
  company's `lookback_days`; `restricted` / `blocked_until` stay account-wide.
- `referral`: an existing referral account keeps its company (code, balance,
  invited list are of that company); a new account is created in the resolved
  company. New codes are unique across all companies; on a (practically
  impossible) collision → `409 { error: "REFERRAL_CODE_COLLISION_RETRY" }`.

Client impact: the marketplace app (`referral_page.dart`, loyalty/restriction
screens) does not send `branch_id` yet — fine while there is one company,
must be updated before a second company is created.

## Referral codes at sign-up

`POST /api/auth/telegram/verify-code`, phone OTP and email registration with a
referral code: the code must resolve to exactly one referral account; a code
present in two companies is rejected like an unknown one (`400 Invalid referral code` /
`INVALID_REFERRAL_CODE`). The referral, its daily limit, expiry and bonus
settings belong to the code owner's company.

## Marketplace bookings and no-shows

- `POST /api/marketplace/catalog/group-bookings`: limits (`booking_limits`),
  services (must be active, of the branch's company, branch's own or shared) and
  prices come from the booked branch's company; the visit is recorded on that
  company's client with the same phone (created if missing). A branch without a
  company → `409 { code: "COMPANY_REQUIRED" }`. A service of another company →
  `400 SERVICE_NOT_AVAILABLE_TODAY` (unchanged code).
- Cancelling a booking applies the anti-fraud and points rules of the company
  that owns the booking; confirmed no-shows use that company's
  `no_show_restrictions`.

## Services and prices (all clients)

A service is used for a queue entry (price, duration, name) only when it
belongs to the entry's company and is that branch's own or a shared
(`branch_id` null) service of the same company. Affected: barber
`PATCH /api/barbers/queue/:id` and `…/edit-before-complete` (`service_ids` of
another company or branch → `400 One or more service_ids are invalid`),
`…/complete` (order amount), queue/history totals, kiosk ETA
(`GET /api/kiosk/barbers/:branch_id`), statistics, finance overview, merchant
order totals, marketplace active booking. `DELETE /api/merchant/services/:id`
now deletes only a service of the caller's barbershop (another one → `404`).

## Penalties (`/api/penalties`)

Bound to the caller's company (`403 { code: "COMPANY_REQUIRED" }` without one).
Network roles see and cancel every penalty of their company, including rows with
`branch_id` null; branch roles only their branches. `POST` works again (it threw
`ReferenceError` before).
