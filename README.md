# Express + Supabase Live Queue API

Backend for a barbershop live-queue system (JWT auth for barbers, Supabase persistence, Socket.io updates).

## Netlify deployment (serverless)
- API lives at `/.netlify/functions/server/*` with redirect `/api/* -> /.netlify/functions/server/:splat` (see `netlify.toml`).
- Netlify Functions do **not** support WebSockets; `broadcastQueueUpdate` becomes a no-op there. Use polling/SSE or host Socket.io elsewhere (Fly.io/Render) if realtime is required.
- Environment variables: set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `CORS_ORIGIN`, etc. in Netlify UI.
- Build: `npm run build` is a no-op; function entry is `netlify/functions/server.js` (wraps `src/app.js`).

## Setup

- Copy `.env.example` to `.env` and fill `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`.
- Install deps: `npm install`
- Start dev server: `npm run dev` (defaults to `http://localhost:4000`)

## Cashback (loyalty)

- Cashback is stored in `cashback_wallets` and is attached to `clients` (phone-based identity).
- Cashback начисляется **с каждого завершенного заказа** (status=`completed`) в процентах от суммы услуг (`services.base_price`), с учётом промокода (если он был применён).
- Marketplace orders can **spend cashback at booking time** via `POST /api/kiosk/book` with `source=site`, `use_cashback=true` and `Authorization: Bearer <marketplace token>`; kiosk/point orders (`source=point`) cannot use cashback.
- По умолчанию cashback выключен. Чтобы включить — задайте `CASHBACK_PERCENT` в окружении (например `5` = 5%).
- Для оплаты сертификатом cashback не начисляется.
- Убедитесь, что SQL из `db/supabase/cashback.sql` применён в вашей базе.
- One-time backfill for already completed orders (after deploy): `npm run backfill:cashback` (optional: `--since`, `--until`, `--batch`, `--max`, `--verbose`).

## Key Endpoints

- `POST /api/auth/login` — returns JWT + barber data (if role = barber)
- `POST /api/auth/register` — create user (role-driven); for barbers also creates profile
- `GET /api/auth/me` — current user from JWT
- `GET /api/barber/queue` — barber’s queue (waiting + called)
- `GET /api/barbers/me?period=YYYY-MM` — current barber profile with `barber.finance` details for the selected month
- `GET /api/verifix/events` — barber activity log with lateness fields
- `POST /api/verifix/events` — record kiosk activity (`login`, `logout`, `shift_start`, `shift_end`, `break_start`, `break_end`)
- `GET|POST|PATCH|DELETE /api/verifix/schedules` — planned work schedules for branches or individual barbers
- `GET /api/barbers/queue/:id/reassign-options` — available barbers for queue reassignment, sorted from most available to busiest
- `PATCH /api/barbers/queue/:id/reassign` — move a queue entry to another barber, or auto-pick the most available barber
- `POST /api/queue/:id/{call|start|reject|complete|pause}` — status transitions; `complete` auto-calculates amount from service price(s) if not provided
- `GET /api/monitor/barbers?branch_id=...` — barbers on a branch + queues (client initials)
- `POST /api/monitor/queue` — enqueue client (`barber_id` optional, auto-picks least busy on shift; `service_id` can be an array, first ID stored as primary, full array saved to `service_ids`)
- `GET /api/monitor/queue/:id/status` — current status + ETA
- `POST /api/monitor/queue/:id/cancel` — cancel from client side
- `GET /api/services` — list services (use before enqueue to obtain `service_id`); response now also includes `categories: [{ category, services: [...] }]`
- `POST /api/services` — create service (admin roles)
- Note: if your DB is missing `service_ids` column in `queue_entries`, apply the SQL in `schema.sql` (or run `ALTER TABLE queue_entries ADD COLUMN service_ids uuid[];`). Code will gracefully fall back to single `service_id` but multi-service sums require the column.

- Marketplace barbershops catalog (barbershop = row in `branches`):
  - `GET /api/marketplace/barbershops` (`?active=true` optional)
  - `GET /api/marketplace/barbershops/:id`
  - `POST /api/marketplace/barbershops`
  - `PATCH /api/marketplace/barbershops/:id`
  - `POST /api/marketplace/barbershops/:id/{activate|deactivate}`

## Notes

- Swap logic on reject: first reject pushes the entry behind the next waiting client and sets `swapped_flag`; second reject marks `rejected`.
- `pause` falls back to `status=waiting` because the DB check constraint does not allow a dedicated paused status.
- Socket rooms use `branch:{branch_id}`; monitors can join via `join_branch` event.
- Barber login requires `branch_id` to pin the session to a branch (updates `users.branch_id` and `barbers.branch_id` for kiosk visibility).
- Monitor enqueue accepts `service_id` or `service_ids` array; first ID is stored as `service_id`, full list saved in `service_ids`.
- Payments: if `amount` is omitted on `POST /api/queue/:id/complete`, it is calculated by summing `base_price` of all `service_ids` attached to the entry.

## Daily Queue Auto-Close

The backend starts an internal scheduler with `npm start` / `node src/server.js`. No button click or external request is required. Serverless functions do not keep background timers alive, so use this on the long-running Node/PM2 deployment.

Behavior:

1. Every day at local midnight the scheduler finds open queue entries created before the current day.
2. Only no-arrival statuses are closed: `waiting`, `called`, and `swapped`.
3. Matching entries are updated to `status=no_show` and `finished_at=<cleanup time>`.
4. The scheduler emits Socket.io `queue:update` with `type=queue_auto_closed` for each affected branch.
5. On server startup it also runs the same cleanup once, so missed midnight cleanup is handled after restart.

Configuration:

- `QUEUE_AUTO_CLOSE_TIMEZONE=Asia/Tashkent` controls midnight timezone. Default is `Asia/Tashkent`.
- `QUEUE_AUTO_CLOSE_ENABLED=false` disables the scheduler.
- `QUEUE_AUTO_CLOSE_ON_STARTUP=false` disables startup cleanup but keeps midnight cleanup.

## Verifix Activity And Lateness

Apply `db/supabase/verifix.sql` before using Verifix.

Schedules:

- `POST /api/verifix/schedules` creates a planned start time.
- Body for a branch default schedule:
  `{ "branch_id": "...", "day_of_week": 1, "start_time": "09:00", "end_time": "20:00", "grace_minutes": 5 }`
- Body for an individual barber schedule:
  `{ "branch_id": "...", "barber_id": "...", "day_of_week": 1, "start_time": "10:00", "grace_minutes": 0 }`
- `day_of_week` uses `0=Sunday`, `1=Monday`, ..., `6=Saturday`.
- If a barber has a personal schedule for the day, it is used first. Otherwise the branch schedule (`barber_id=null`) is used.

Events:

- `POST /api/verifix/events` records an event from the barber kiosk or dashboard.
- Barber JWT records only its own events. Admin JWT can pass `barber_id`.
- Supported `event_type`: `login`, `logout`, `shift_start`, `shift_end`, `break_start`, `break_end`, `manual_adjustment`.
- For `login` and `shift_start`, backend compares `occurred_at` with the planned `start_time + grace_minutes`.
- Response stores `is_late`, `late_by_minutes`, `schedule_id`, and `scheduled_start_at`.
- Existing barber actions also create Verifix logs: `POST /api/barbers/login` logs `login`, `POST /api/barbers/logout` logs `logout`, break endpoints log `break_start` and `break_end`.

Examples:

```http
POST /api/verifix/events
Authorization: Bearer <barber JWT>
Content-Type: application/json

{ "event_type": "shift_start", "occurred_at": "2026-05-10T04:10:00.000Z" }
```

```http
GET /api/verifix/events?branch_id=<branch_id>&start_date=2026-05-10&end_date=2026-05-10&late_only=true
Authorization: Bearer <admin JWT>
```

## Barber Profile Finance

`GET /api/barbers/me` returns `barber.finance` for the current month. Use `?period=YYYY-MM` to request another month.

Response fields:

- `total_earned` — total earned amount. Backend uses `finance_snapshots.payload.employees[barberId].profit` when it is set; otherwise it calculates completed queue revenue from service prices or `price_override`.
- `goal` — target amount from `finance_snapshots.payload.employees[barberId].salary`.
- `advance` — advance amount from `finance_snapshots.payload.employees[barberId].advances`.
- `penalty` — penalty amount from `finance_snapshots.payload.employees[barberId].penalty`.
- `payout` — amount to pay out: calculated commission minus advance and penalty.
- `commission`, `profit_percent`, and `bonus_profit_percent` are included for transparency.

Apply `db/supabase/finance_snapshots.sql` if the database does not have `finance_snapshots` yet.

## Barber Reassignment API Workflow

1. Fetch candidates: `GET /api/barbers/queue/:id/reassign-options` with `Authorization: Bearer <barber JWT>`.
2. Backend checks that the queue entry belongs to the current barber and is still reassignable (`waiting`, `called`, or `swapped`).
3. Response returns `candidates`, sorted by `estimated_waiting_time`, then `current_clients`, then barber name. Current barber is excluded, inactive and off-shift barbers are excluded.
4. Reassign manually: `PATCH /api/barbers/queue/:id/reassign` with body `{ "barber_id": "<target barber id>" }`.
5. Reassign automatically: call the same PATCH endpoint with an empty body; backend picks the first candidate, meaning the most available barber.
6. Backend updates the entry to `status=waiting`, changes `barber_id`, clears `started_at`, sets `swapped_flag=true`, and moves `created_at` after the target barber's last active queue item so the client appears at the end of the selected barber's list.
7. Backend emits Socket.io `queue:update` with `type=queue_reassigned`, so clients can refresh both the old and new barber queues.

## User Journey Map (Blocks 1 and 2)

- **Network Admin**
  - Create branch: `POST /api/branches`
  - Edit branch: `PATCH /api/branches/:id`
  - Activate/deactivate: `POST /api/branches/:id/{activate|deactivate}`
- **Barber**
  - Register (role `barber`): `POST /api/auth/register`
  - Login (requires `branch_id` to bind shift to a branch): `POST /api/auth/login` → JWT (payload contains `barberId`)
  - View own queue: `GET /api/barber/queue` (only `waiting`/`called`, with ETA)
  - Call client: `POST /api/queue/:id/call`
  - Start service: `POST /api/queue/:id/start`
  - Reject/swap: `POST /api/queue/:id/reject` (1st time swaps, 2nd rejects)
  - Complete with payment: `POST /api/queue/:id/complete` (amount + method)
  - Pause (returns to waiting): `POST /api/queue/:id/pause`
- **Client / Kiosk**
  - See barbers and queues: `GET /api/monitor/barbers?branch_id=...`
  - Join queue: `POST /api/monitor/queue` (client_name, phone, service_id or service_ids[], optional barber_id)
    - If `barber_id` is missing, picks the least busy on-shift barber
  - Check status: `GET /api/monitor/queue/:id/status` (status + ETA)
  - Cancel: `POST /api/monitor/queue/:id/cancel`
- **Services**
  - List: `GET /api/services` (`?active=true` to filter, `?grouped=true` to return only grouped output); default response includes both `data` (flat list) and `categories` (array of `{ category, services }`).
  - Create: `POST /api/services` (admin_network/admin_branch) — accepts optional `category` string.
  - Update: `PATCH /api/services/:id` (admin_network/admin_branch)
  - Activate/deactivate: `POST /api/services/:id/{activate|deactivate}` (admin_network/admin_branch)
- **Realtime**
  - Status/queue changes broadcast via `queue:update` (Socket.io)
  - Monitors join `branch:{branch_id}` room (join_branch)

## Branch Management Endpoints

- `GET /api/branches` (`?active=true` for active only)
- `GET /api/branches/:id`
- `POST /api/branches` (admin_network)
- `PATCH /api/branches/:id` (admin_network)
- `POST /api/branches/:id/activate` (admin_network)
- `POST /api/branches/:id/deactivate` (admin_network)

## Service Endpoints

- `GET /api/services` (`?active=true` for active only, `?grouped=true` to return categories only; default adds `categories` alongside flat list)
- `GET /api/services/:id`
- `POST /api/services` (admin_network, admin_branch)
- `PATCH /api/services/:id` (admin_network, admin_branch)
- `POST /api/services/:id/activate` (admin_network, admin_branch)
- `POST /api/services/:id/deactivate` (admin_network, admin_branch)

## Admin Login Endpoint

- `POST /api/barbers/admin/login`
- Body: `{ "login": "...", "password": "..." }`
- Roles: `admin_network`, `admin_branch`
- Response: `{ "token": "...", "user": { "id", "login", "role", "branch_id" } }`
- `branch_id` is optional for admins, but if it exists in `users`, it is included in both JWT `branchId` and response `user.branch_id`

## Kiosk Ads (YouTube)

- Apply SQL: `db/supabase/kiosk_ads.sql`
- Kiosk config now includes playlists:
  - `GET /api/kiosk/config` → `{ ..., ads: { regular: string[], kids: string[], updated_at } }`
- Admin endpoints (use `Authorization: Bearer <token>` from admin login):
  - `GET /api/kiosk-ads/settings`
  - `PATCH /api/kiosk-ads/settings` body example: `{ "regular_urls": ["https://youtu.be/..."], "kids_urls": ["https://www.youtube.com/watch?v=..."] }`

## AI prompt to recreate this project

```
Build an Express + Supabase backend for a barbershop live-queue system with JWT auth and Socket.io updates.
- Entities: branches, barbers (id=users.id, phone, photo, specialization, is_authorized, is_on_shift), services (duration_minutes, base_price, is_active), clients (name, phone unique), queue_entries (client_id, branch_id, barber_id, service_id + service_ids[], status waiting|called|swapped|rejected|in_progress|completed|cancelled|no_show, source point|site|admin, payment_method cash|card|certificate, timestamps), payments (amount, method), media_assets (ads|music|kids|video, barber_id optional).
- Auth: /api/auth/register, /api/auth/login (barber must supply branch_id), /api/auth/me. Token payload includes barberId and branchId.
- Barber workspace: /api/barber/queue (today only, auto-reject stale via timeout_minutes, includes services, price, payment, eta), /api/barber/queue/:id/reject, /api/barber/queue/:id/swap, /api/barber/queue/:id (patch services/payment/client info), /api/barber/stats, /api/barber/history, /api/barber/profile (get/patch), /api/barber/shift/start, /api/barber/shift/stop, media CRUD /api/barber/media (list/create/update, scoped to barber or shared).
- Queue actions (shared): /api/queue/:id/{call|start|complete|pause} as needed.
- Client/kiosk: /api/monitor/barbers?branch_id=, /api/monitor/queue (enqueue client with service_ids array), /api/monitor/queue/:id/status, /api/monitor/queue/:id/cancel.
- Services and branches CRUD for admins.
- Realtime: broadcast queue:update to room branch:{branch_id}.
- CORS configurable via env, server port 4000 default.
Provide schema.sql with all tables/indexes and safety ALTERs, and .env example for SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, CORS_ORIGIN.
```
