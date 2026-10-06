# API contracts

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

### `GET /api/kiosk/barbers/:branch_id`

Queue-derived fields use only `waiting`, `called`, `swapped`, and `in_progress`.

- `is_available` is the authoritative booking flag. It is `true` only when the employee is active, on shift, and has no active queue entries.
- `availability_status` is `available`, `busy`, `off_shift`, or `inactive`.
- `active_queue_count`, `has_in_progress`, and `current_service_overdue` describe the current workload.
- `estimated_waiting_time` sums planned time for queued entries and remaining time for `in_progress`. An unfinished `in_progress` entry always contributes at least one minute, even after its planned duration elapsed.
- Each client item exposes `estimated_time`, `estimated_remaining_time`, and `is_overdue`.

Queue lifecycle and service edits emit `queue:update` to `branch:<branch_id>` so Kiosk must refetch this endpoint on that event.

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

Request: `{ "phone": "+998901234567" }` (E.164; spaces, brackets and hyphens are normalized).

If the phone is not linked, response is `{ "requiresTelegramLink": true,
"linkToken": "...", "botUrl": "https://t.me/<bot>?start=...", "expiresIn": 300 }`.
The mobile app opens `botUrl` and the Bot API webhook completes the binding.
If already linked, the backend generates a six-digit OTP and sends it through
the ordinary Bot API. OTP hashes only are persisted.

`POST /api/auth/telegram/link` is an alias of `send-code`.

### `POST /api/auth/telegram/verify-code`

Also available under `/api/marketplace/auth/telegram/verify-code`.

Request: `{ "challenge_id": "...", "phone": "+998901234567", "code": "123456", "first_name": "...", "last_name": "...", "language": "ru" }`.
`challenge_id` may be omitted when `phone` is supplied; the latest active
challenge is used. On success the endpoint marks the phone verified, persists
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
