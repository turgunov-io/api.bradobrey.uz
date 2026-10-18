# Production deployment

## API service

- Host: `95.46.96.213`
- Checkout: `/var/www/api.bradobrey.uz`
- PM2 process: `BRADOBREY-BARBER`
- Public health check: `https://api.bradobrey.uz/health`
- The dashboard runs separately at `/var/www/dash.bradobrey.uz` as
  `bradobrey-dashboard`.

The production API Git checkout has substantial local divergence and uncommitted
changes. Do not use `git pull`, `reset`, or a checkout reset there. Deploy a
reviewed file overlay so `.env`, dependencies, uploads, dashboard files, and
unrelated backend modules stay in place.

For an API-only release:

1. Review and test the local change; prepare an archive containing only the
   required API files.
2. Back up every existing target file under `/var/backups`.
3. Apply required database migrations before code that reads the new schema.
   Prefer additive, idempotent migrations and execute them transactionally.
4. Overlay the reviewed files, run `node --check` on changed JavaScript, and
   restart only `BRADOBREY-BARBER`.
5. Confirm the API PM2 process is online and `/health` returns HTTP 200. Check
   that `bradobrey-dashboard` remains online and unchanged.

## 2026-10-16 kiosk session presence release

- Applied `db/postgres/employee_branches.sql`; this added session columns and
  ensured the employee branch tables/indexes exist.
- Deployed the session-aware employee API and kiosk roster files from the
  reviewed local commit, then restarted only the API PM2 process.
- API health returned HTTP 200. The dashboard process ID remained unchanged.
- Rollback source archive: `/var/backups/api.bradobrey.uz-session-presence-pre-20261016.tar.gz`.
- A physical kiosk and authenticated barber workflow were not available for
  end-to-end verification.

## 2026-10-18 queue transfer outcome notification release

- Applied `db/postgres/notifications.sql` transactionally; `employee_push_tokens` exists.
- Deployed `src/models/notifications.js`, `src/models/queueTransfers.js`, `src/routers/barbers.js`, `src/routers/notifications.js`, and `src/services/marketplacePush.js` as a file overlay. Backup: `/var/backups/api.bradobrey.uz-transfer-notifications-pre-20261018-212702.tar.gz`.
- Restarted only `BRADOBREY-BARBER`; `/health` returned 200, authenticated route probes returned 401, and the dashboard process PID was unchanged.
- Live authenticated accept/reject and physical-device FCM delivery were not exercised. Barber App rollout and FCM token registration are required for actual device delivery.

## 2026-10-18 Verifix schedule correction

- Added API validation requiring a same-day schedule end after its start on create, update, and weekly bulk operations. Updated the branch schedule and personal schedule Dashboard forms to prevent invalid intervals.
- Corrected six active Chimgan employee overrides from 10:00–09:00 to 10:00–20:00 transactionally; other days and branch-default schedules were unchanged. Pre-change row backup: `/var/backups/chimgan-personal-schedule-pre-20261018-1792344430045.json`.
- API source backup: `/var/backups/api-verifix-validation-pre-20261018-222400.tar.gz`; Dashboard source and prior `.output` backup: `/var/backups/dashboard-verifix-validation-pre-20261018-222400.tar.gz`.
- Restarted `BRADOBREY-BARBER` and `bradobrey-dashboard`; both are online. API `/health` and Dashboard `/login` returned HTTP 200. Production Dashboard had unrelated dirty employee/login files; they were preserved.
