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

## Key Endpoints

- `POST /api/auth/login` — returns JWT + barber data (if role = barber)
- `POST /api/auth/register` — create user (role-driven); for barbers also creates profile
- `GET /api/auth/me` — current user from JWT
- `GET /api/barber/queue` — barber’s queue (waiting + called)
- `POST /api/queue/:id/{call|start|reject|complete|pause}` — status transitions; `complete` auto-calculates amount from service price(s) if not provided
- `GET /api/monitor/barbers?branch_id=...` — barbers on a branch + queues (client initials)
- `POST /api/monitor/queue` — enqueue client (`barber_id` optional, auto-picks least busy on shift; `service_id` can be an array, first ID stored as primary, full array saved to `service_ids`)
- `GET /api/monitor/queue/:id/status` — current status + ETA
- `POST /api/monitor/queue/:id/cancel` — cancel from client side
- `GET /api/services` — list services (use before enqueue to obtain `service_id`); response now also includes `categories: [{ category, services: [...] }]`
- `POST /api/services` — create service (admin roles)
- Note: if your DB is missing `service_ids` column in `queue_entries`, apply the SQL in `schema.sql` (or run `ALTER TABLE queue_entries ADD COLUMN service_ids uuid[];`). Code will gracefully fall back to single `service_id` but multi-service sums require the column.

## Notes

- Swap logic on reject: first reject pushes the entry behind the next waiting client and sets `swapped_flag`; second reject marks `rejected`.
- `pause` falls back to `status=waiting` because the DB check constraint does not allow a dedicated paused status.
- Socket rooms use `branch:{branch_id}`; monitors can join via `join_branch` event.
- Barber login requires `branch_id` to pin the session to a branch (updates `users.branch_id` and `barbers.branch_id` for kiosk visibility).
- Monitor enqueue accepts `service_id` or `service_ids` array; first ID is stored as `service_id`, full list saved in `service_ids`.
- Payments: if `amount` is omitted on `POST /api/queue/:id/complete`, it is calculated by summing `base_price` of all `service_ids` attached to the entry.

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
