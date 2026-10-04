# API contracts

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

Existing queue update contract. `service_id`/`service_ids` are validated before persistence. The response entry also contains `services`, `total_duration`, `total_price`, and `started_at`. Service/payment changes emit `queue:update` with type `queue_updated`.

### `PATCH /api/barbers/queue/:id/edit-before-complete`

Accepted optional fields:

- `service_ids`: replace the service list;
- `add_service_ids`: append unique services;
- `amount` plus mandatory `reason`: set a manual final-price override.

The assigned barber may edit any non-terminal entry, including `in_progress`. A service-only edit clears an older price override and recalculates service total/duration. The response is enriched like the generic queue update and emits `queue_updated`.

### `PATCH /api/barbers/queue/:id/no-show`

Requires the assigned barber/manager JWT. `no_show=true` permits only `waiting`, `called`, or `swapped` to `no_show`; `no_show=false` permits only `no_show` to `waiting`. Repeating the same target state returns `200` with `idempotent: true`; conflicting terminal states return `409`. A successful transition emits `queue_no_show` or `queue_no_show_reverted` through `queue:update`.

### `PATCH /api/barbers/queue/:id/not-in-time`

Requires the assigned barber/manager JWT. Only `called` or `in_progress` entries may transition to `not_in_time`. Repeating an already completed `not_in_time` request returns `200` with `idempotent: true`; conflicting states return `409`. The update is guarded against concurrent status changes and emits `queue_not_in_time` through `queue:update`.
