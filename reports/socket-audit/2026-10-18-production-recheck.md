# Socket.IO production recheck — 2026-10-18

## Scope

Read-only production checks against `https://api.bradobrey.uz` and static review of the current checkout. No queue calls, authenticated client session, event delivery, database reads, configuration changes, or service restarts were performed.

## Results

- `GET /health`: HTTP 200. This only confirms HTTP liveness.
- `GET /socket.io/?EIO=4&transport=polling`: HTTP 200 with a valid Engine.IO session (`sid`), confirming the public Socket.IO polling endpoint is reachable.
- Sent a Socket.IO namespace connect packet without credentials over that session. The server returned Engine.IO error packet `44` with `SOCKET_AUTH_REQUIRED`, as required by the current authentication middleware.
- SSH inspection of PM2, Nginx, and production source was unavailable: `ubuntu@95.46.96.213` rejected the configured non-interactive key (`Permission denied (publickey,password)`).
- No authenticated test kiosk/barber credential or user symptom trace was available, so positive room membership and actual `queue.client_called`/`queue:call` delivery could not be verified.

## Assessment

The production Socket.IO transport is reachable. This check found no evidence that the public HTTP polling endpoint is down. The unauthenticated namespace rejection is expected and is not itself a socket outage.

Current backend code requires kiosk clients to obtain a short-lived ticket from `POST /api/kiosk/socket-ticket` and connect using `auth: { kioskTicket }`. Employee clients must supply a valid JWT in Socket.IO `auth.token`/`auth.accessToken` (or a Bearer authorization header). Kiosk tickets join their branch room automatically; employee `join_branch` requests are authorized server-side. A client that sends only `branchId` in query parameters will be rejected with `SOCKET_AUTH_REQUIRED`.

The queue-call handlers update the queue record and emit `queue:update`, `queue.client_called`, and `queue:call` to branch rooms; client rooms receive the two explicit call events when a `client_id` exists. Static code review does not prove the deployed handler version or authenticated delivery in production.

## Finding and next diagnostic

- **Confirmed client/server room mismatch (High confidence):** `C:\project\bradobrey_barber\lib\services\barber_socket_service.dart` connects with a valid JWT in Socket.IO auth, but supplies `branchId` only as a query parameter. `C:\project\api.bradobrey.uz\src\server.js` ignores that query parameter for room membership and automatically joins an employee socket only to `employee:<id>`. It requires an explicit, authorized `join_branch` event to join `branch:<id>`. The Barber App never sends `join_branch` after connecting. Thus the socket can authenticate and appear connected while missing branch call events.
- **Broken branch-change helper (High confidence):** the app's `joinBranch` helper sends values like `branch:<id>`, while the server expects the raw branch ID (or `{ branchId: id }`). It also returns early when asked to join the branch already stored during initial connect. This helper cannot repair the initial subscription as currently written.
- API `emitCallEvent` sends `queue:update` to `branch:<id>`; the app listens for `queue:update`, which is the correct event name. The producer/consumer event contract itself matches; missing room membership explains why calls are not received.
- This is a code-level root cause in the inspected checkouts. Production Engine.IO reachability is confirmed, but authenticated production event receipt and deployed client/API revisions could not be proven because SSH and test credentials/device were unavailable.
- **Local fix applied:** `C:\project\bradobrey_barber\lib\services\barber_socket_service.dart` now emits `join_branch` with `{ branchId }` after every successful connect/reconnect, logs the server acknowledgement, and reports `branch_access_denied`. Branch switching/leaving now sends the raw ID in the server-supported object shape. Removed the misleading branch query parameter and reconnect-time listener re-registration.
- The fix is only in the local Barber App checkout and has not been built, installed, or deployed. No tests were run. Next verify with the Barber App and a test branch/account, then release the updated app. Do not restore unauthenticated query-based room joins.

## Limits

No production code, database, PM2, or proxy settings were changed. No load, brute-force, or destructive tests were run. Production PM2 state, deployed source hash, proxy configuration, and authenticated delivery remain unverified in this recheck.
