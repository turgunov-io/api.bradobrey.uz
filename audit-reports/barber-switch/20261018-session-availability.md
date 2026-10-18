# Barber reassignment session availability audit (2026-10-18)

## Root cause

The reassignment candidate query in `src/models/barbers.js` required
`employee_active_branches.updated_at` to be newer than 90 seconds. The Barber
App updates that diagnostic timestamp through `POST /api/barbers/presence`; when
the app is closed/backgrounded, the screen is off, or the device loses network,
the timestamp ages out while the persisted login can still be valid. The same
90-second predicate was present in `targetBarberIsEligible` in
`src/models/queueTransfers.js`, so a candidate could not be submitted even if
only the listing filter were removed.

## Changes

- Both candidate listing and transfer submission now require a non-null
  persisted `session_id` and `session_expires_at > now()`. Branch assignment,
  on-shift state, workspace role, active account, and archive checks remain.
- Barber/manager login JWT TTL is capped at the earlier of the configured
  `JWT_EXPIRES_IN` and next `Asia/Tashkent` midnight. Its database session uses
  the same expiry. Branch switching keeps the earlier existing deadline.
- The existing expiry cleanup revokes the session, clears both shift flags, and
  emits a branch-scoped `barber_status` event. No schema migration was added.
- Added tests for stale heartbeat-independent candidate contracts and midnight
  expiry/deadline preservation. Updated API documentation, changelog, and
  project memory.

## Verification

- API `npm test`: PASS, 136/136.
- API `npm run test:integration`: SKIPPED by the existing integration-test
  guard; no configured integration database was used.
- API `npm run build`: PASS; configured script is a no-op.
- API syntax checks (`node --check` for changed JS) and `git diff --check`:
  PASS.
- Barber App `flutter analyze`: PASS; `flutter test`: PASS, 53 tests;
  `flutter build apk --debug`: PASS.
- Kiosk `flutter analyze`: PASS; `flutter test`: PASS, 39 tests;
  `flutter build apk --debug`: PASS.
- Build output contained existing Gradle/Android Gradle Plugin/Kotlin
  deprecation warnings.

## Security and limits

JWT/session checks remain required; eligibility stays branch-scoped and
role-scoped. No production data or schema was changed, and production was not
changed by migration. On 2026-10-18, the production checkout was backed up and
aligned to `origin/main` commit `2a3a8bf`; the checkout is clean. The backup
bundle and compressed tracked diff are at
`/var/backups/api.pre-pull.20261018T183207Z`.

Production `npm test` passed 136/136. Only PM2 app `BRADOBREY-BARBER` was
restarted; it and the dashboard remained online. Local API `/health` returned
`{"status":"ok"}`. No authenticated barber/device end-to-end check was run.
Existing sessions retain their previously stored expiry until logout or natural
expiry; new login sessions receive the midnight cap. A strict first-midnight
cutover for pre-deployment sessions was not performed.

Follow-up production fix for the reported reassignment-options HTTP 500:
PostgREST's configured query builder does not implement `.not()`. Removed that
builder call and discard assignments with a null `session_id` in application
code, while retaining the database-side branch, shift, and future-expiry
filters. Added a regression contract assertion. Commit `53a1a4a` was pushed to
`main`; local and production `npm test` both passed 136/136. Production was
fast-forwarded to `53a1a4a`, only `BRADOBREY-BARBER` was restarted, API health
returned `{"status":"ok"}`, and `git status --short --branch` was clean.

The API repository is on `main` and already has one local commit ahead of
`origin/main` (`eb50e14`), plus pre-existing working-tree changes in
`.project/MEMORY.md` and an untracked Socket.IO report. The Barber App and Kiosk
repositories also contain pre-existing modifications. Those were preserved.
