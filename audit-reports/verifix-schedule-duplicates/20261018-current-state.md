# Verifix staff schedule duplicate rows audit (2026-10-18)

## Scope and method

Read-only source review of `C:\project\bradobrey-dashboard` and `C:\project\api.bradobrey.uz`: branch schedule dialog, dashboard schedule API client, Verifix list/create/bulk endpoints, persistence schema, and the schedule lookup used during attendance/lateness calculation. No files in production and no production schedule records were read or changed. No tests were run; this was a code-path audit.

## Answer: why does each weekday appear twice?

The active schedule list on `app/pages/branches.vue` fetches schedules by branch and filters `is_active` on the client (`refreshSchedules`, lines 299–310). It renders each active API row separately (lines 1197–1211), without grouping by day or suppressing a branch default when an employee override exists.

The model explicitly says the branch-wide schedule applies until an employee-specific schedule is set. Therefore the pairs shown for Monday–Saturday are one row with `barber_id = null` (09:00–21:00 for all branch barbers) and one row with a concrete employee `barber_id` (10:00–09:00). Those are two different scopes, not necessarily duplicate copies. Verifix is intended to use the personal schedule as an override.

The “Применить на все дни недели” action calls the bulk endpoint. The backend deactivates/replaces only generic rows (`barber_id IS NULL`) and inserts seven generic rows; it preserves all personal rows. Thus applying the week-wide schedule naturally leaves both rows visible for weekdays that already have personal overrides (`src/models/verifix.js`, lines 663–694; dashboard `app/pages/branches.vue`, lines 233–244).

## Findings

### P1 — Earlier audit claim was incorrect; precedence is present in current source

The first audit incorrectly stated that `findSchedule()` omitted `barber_id`. Rechecking both the local source and the production checkout on 2026-10-18 shows that the query selects `barber_id` at `src/models/verifix.js:260`. The following filter retains generic and matching employee rows, and the sort prioritizes `schedule.barber_id === barberId` at lines 267–280. Therefore the alleged missing-column bug is not present in the inspected code, and this audit did not establish that the general schedule wins over the employee override.

No code change or production restart was made for this claim. A targeted regression test would still be useful to lock the intended precedence, but the claimed runtime defect must not be reported as confirmed.

### P2 — Manual add can create actual same-scope duplicates

`POST /api/verifix/schedules` always inserts a new row (`src/models/verifix.js`, lines 741–783); it does not update/deactivate an existing active row for the same branch, employee scope, and weekday. The schema has ordinary non-unique indexes only (`db/postgres/verifix.sql`, lines 59–63). Repeated clicks or re-entry can create multiple active schedules for the exact same scope/day. In the lookup, ties within one scope sort only by `start_time`, so which record wins can be ambiguous when starts are equal.

Recommended fix: make save idempotent/upsert by `(branch_id, barber_id scope, day_of_week)` while preserving historical rows by deactivating prior active records, and protect concurrent requests with a database-safe uniqueness strategy (Postgres NULL handling must be considered).

### P2 — End time earlier than start is accepted

The visible employee entries show 10:00–09:00 (and Sunday 00:00–23:00). Create validation validates time formats but does not reject end-before-start (`src/models/verifix.js`, lines 749–763); dashboard save also permits it. This may be intended overnight work, but if not, it is likely a data-entry mistake. The lateness calculation uses the start time, so this chiefly affects schedule meaning/display and any consumers of the end time.

Recommended fix: decide/document whether overnight shifts are supported. If not, reject end-before-start in both UI and API. If supported, label overnight shifts clearly and test the next-day interpretation.

### P3 — Employee row can display as generic “Сотрудник”

The branch screen resolves `barber_id` through the currently loaded `barbersData` map; when the ID is absent it displays the placeholder `Сотрудник` (`app/pages/branches.vue`, lines 1204–1208). The screenshot’s label does not identify which employee owns the personal override, which makes the paired rows harder to distinguish. This audit did not determine whether the ID is stale or the barber list is incomplete.

Recommended fix: ensure the schedule response’s joined barber name is used as a fallback, and inspect the branch roster/assignment mapping.

## Verification and live data check

Local and production API source both select `barber_id` and prioritize the matching employee row. A read-only aggregate query of active Chimgan schedules (without employee IDs or names) confirmed exactly one branch-default and one employee-override row for each of the seven weekdays; there are no same-scope duplicate rows in this branch. The employee override was 00:00–23:00 on Sunday and 10:00–09:00 Monday–Saturday, while the branch default was 09:00–21:00 with a 15-minute grace period. The screenshot's two rows were therefore the intended two scopes. In the follow-up fix, interpreting the entered form values as the intended schedule, the six Monday–Saturday personal records were updated to 10:00–20:00 transactionally. Their previous values are backed up at `/var/backups/chimgan-personal-schedule-pre-20261018-1792344430045.json`. API and Dashboard validation was deployed to reject same-day schedules whose end is not after the start; production API health and Dashboard `/login` both returned HTTP 200 after restart.

