# Barber and branch switching audit (2026-10-18)

## Result

The device logs confirmed two Flutter provider-scope exceptions in the queue reassignment flow. The first prevented the sheet from building; after that fix, a `202` transfer was created successfully, but a second exception prevented the queue refresh and success message. Both Flutter fixes are in `C:\project\bradobrey_barber`.

Follow-up request: the originating barber needs audible in-app feedback when the target accepts or rejects. The API outcome event now includes both transfer participants and the transfer ID; the Barber App filters to `fromBarberId` and plays distinct accepted/declined cues with localized status text.

## Evidence

- Flutter queue UI calls `GET /api/barbers/queue/:id/reassign-options` and `PATCH /api/barbers/queue/:id/reassign` with a Bearer token, `barber_id`, and idempotency key. It treats the API's `202 transfer_pending` as pending and refreshes the personal queue.
- The API documents the same `202` transfer workflow. A target barber completes it through authenticated `PATCH /api/barbers/queue/transfers/:transferId/accept` or `/reject`; Flutter has pending-transfer listing and decision calls.
- `POST /api/barbers/me/branch` expects authenticated JSON `{ "branch_id": "…" }`, checks persisted employee session and branch access, persists the new active branch, and returns a refreshed JWT. Explicitly denied/inactive branches are rejected.
- Flutter has no in-app active-branch switch UI or call to `/barbers/me/branch`. It only selects a branch during login. Therefore, if the reported action is switching the signed-in barber's workplace, the client path is absent rather than a mismatched request.
- The supplied device log reports `ProviderNotFoundException` for `GetBarberReassignOptionsUseCase` while building `QueueReassignSheet`, followed by a null-to-`QueueReassignCubit` cast. The callback came from a pushed `ClientDetailPage` route which provides `BarberRepository` and `QueueBloc`, but not the parent page's reassign use-case providers.
- Flutter now resolves the existing route-scoped `BarberRepository` before opening the modal and constructs both reassign use cases from it. This removes the dependency on providers that the pushed route does not inherit. A widget regression test exercises the modal from that exact route scope.
- The follow-up log shows `PATCH /api/barbers/queue/:id/reassign` returned `202` and created a pending transfer, then `ProviderNotFoundException` occurred for `QueueBloc` after the modal returned. Some callers pass a nested sheet context that is outside the queue bloc provider. The queue refresh and feedback now use the owning `_QueuePageContentState` context, which is under the page's `QueueBloc` provider.
- Existing API `employeeBranchSwitch.e2e.test.js` exercises branch selection and wiring but is not an HTTP/PostgreSQL end-to-end test. No PostgreSQL-backed branch-switch or authenticated Flutter-to-API run was available. Production was not accessed.

## Verification

- Backend `npm test`: PASS, 125/125.
- Backend `npm run test:integration`: BLOCKED/SKIPPED; the only integration test is disabled unless `MARKETPLACE_INTEGRATION=1` and configured database access are provided; it does not exercise employee branch switching.
- Flutter `flutter analyze`: PASS, no issues.
- Flutter `flutter test`: PASS, all tests passed (52), including provider-scope and transfer outcome routing cases.
- Android `flutter build apk --debug`: PASS; generated `app-debug.apk` (Gradle/AGP/Kotlin future compatibility warnings only).
- `git diff --check`: PASS in both repositories.
- Transfer acceptance/rejection sounds and user-facing status notifications are implemented in the Barber App. The event contract and recipient filtering have unit coverage; physical-device audio playback remains to be confirmed after installing a build with these changes.

## Limits / follow-up evidence needed

The logged provider exception is covered by the fix and regression test. Current queue reassignment remains an approval workflow, so a request remains pending until the target barber accepts or rejects it. A signed-in user's branch switch still cannot be initiated from Flutter because no UI/client call exists. Production was not retested.
