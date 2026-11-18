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

## Database schema: base files, then numbered migrations

Two layers, always in this order:

1. **Base schema** — `db/postgres/*.sql`, idempotent (`create ... if not exists`,
   `add column if not exists`), applied by `./scripts/apply-schema.sh`. Safe to
   re-run; it creates missing tables/columns and never touches company data.
2. **Numbered migrations** — `db/migrations/NNN_name.sql`, applied by
   `npm run migrate` (`scripts/migrate.js`, same DB env as the API). Each file runs
   once, in its own transaction, recorded in `schema_migrations` with a checksum;
   an edited applied file aborts the run. `npm run migrate -- --dry-run` lists
   pending files. Sub-folders are never executed: `down/` holds manual rollbacks
   (`psql -v ON_ERROR_STOP=1 -1 -f ...`).

New schema changes go into a new numbered migration; base files only get
changes needed to keep re-runs compatible (e.g. role lists). Fresh database:
`apply-schema.sh` then `npm run migrate`.

Multi-tenancy (Phase 1 step A, `MULTI_TENANCY.md` section 9), first rollout:

1. Take a DB backup. Run section A of `db/checks/multi_tenancy_checks.sql`
   (which barbershop is Bradobrey). Set `MIGRATE_SEED_BARBERSHOP_ID` if the
   heuristic (most branches) is wrong; `MIGRATE_SEED_COMPANY_CODE` /
   `MIGRATE_SEED_COMPANY_NAME` to override `BRADOBREY` / `Bradobrey`;
   `MIGRATE_ALLOW_BARBERSHOP_SPLIT=on` only if another barbershop's branches
   really are a separate business.
2. Rehearse on a copy of the production dump first, then run in a maintenance
   window (ALTERs take ACCESS EXCLUSIVE locks; `MIGRATE_LOCK_TIMEOUT`, default 15s).
3. `npm run migrate`, then sections B–D of the checks file: every
   `problem_rows` must be 0.
4. Migrations 001–006 are behaviour-neutral for the old single-company API.
   `007_drop_global_uniques.sql` (former `deferred/101`) is NOT: the old code
   upserts on `clients.phone` / `platform_settings.key`. Phase 1 release order
   (MULTI_TENANCY.md 9.9): stop API → `apply-schema.sh` → `npm run migrate`
   (001–008) → checks B–D = 0 → deploy this API → update apps. Rehearse the whole
   sequence on a copy of the production dump first. `008_company_kiosk_enrollment.sql`
   (per-company kiosk enrollment code hash) is additive, but the new API selects
   the column, so it must be applied before the code.
5. `app.tenant_strict` stays off; enabling it is described in MULTI_TENANCY.md 9.9.
   The API refuses to create a second company (`409 MULTI_COMPANY_PRECONDITIONS`)
   until `KIOSK_AUTH_ENFORCE=true` and `app.tenant_strict = on`.

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
# Telegram OTP deployment note — 2026-10-19

- The production Bot token was rotated outside Git and validated with Telegram
  `getMe`; secret values are intentionally not recorded here.
- Production webhook was configured without deleting pending updates:
  `/api/integrations/telegram/webhook`, protected by the runtime webhook secret,
  with `message` updates only. `getWebhookInfo` reported a configured URL,
  zero pending updates, and no last error after setup.
- The source hardening is tested locally before deployment. Deploy only the
  reviewed Telegram source/script/package/example/test/report files, preserve
  unrelated production worktree changes, restart only `BRADOBREY-BARBER`, and
  verify `/health`, PM2 status, webhook info, and both webhook-secret paths.
- A real OTP completion still requires a human test account/chat interaction;
  no user phone or OTP is stored in deployment documentation.

