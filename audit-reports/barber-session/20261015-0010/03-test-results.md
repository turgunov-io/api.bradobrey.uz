# QA test results

## Passed

- `flutter analyze` в `C:\project\bradobrey_barber` — No issues found.
- `flutter test --reporter expanded` — 46 tests passed.
- backend `npm test` — 108/108 passed ранее при текущем checkout.
- backend `npm run test:integration` — 1 skipped, PostgreSQL unavailable/not enabled.
- backend presence contract tests — passed: logout clears both presence stores transactionally; kiosk requires fresh on-shift presence.
- `https://api.bradobrey.uz/health` — HTTP 200, liveness only.

## Not verified

- Real authenticated barber login/logout at 00:00.
- Real token expiry at 12h/15h.
- Production JWT environment and deployed commit.
- Production 401 source from nginx/PM2/API.
- Device timezone behavior and background timer after force-kill.
- Full kiosk device E2E after midnight.

