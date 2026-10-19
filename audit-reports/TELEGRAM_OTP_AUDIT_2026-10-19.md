# Telegram OTP audit — 2026-10-19

## Scope

Audited the Node/Express backend, Telegram Bot API integration, OTP service,
PostgreSQL migration, tests, PM2 runtime, and the production endpoint at
`api.bradobrey.uz`. Secrets, OTP values, and user identifiers are intentionally
omitted from this report.

## Root cause

Production had valid Telegram bot credentials, but Telegram `getWebhookInfo`
reported no configured webhook and three pending updates. The backend receives
`/start` and contact updates only through
`POST /api/integrations/telegram/webhook`; it does not run a polling worker.
Therefore the app could create a deep-link challenge, but the backend never
received the user's `/start` or shared contact and could not generate/send the
OTP.

The production webhook was configured to the existing route with the existing
secret-token header and `allowed_updates=["message"]`. Pending updates were
not deleted. Telegram subsequently reported a configured webhook, zero pending
updates, and no last error.

## Findings and remediation

| ID | Severity | Finding | Remediation |
| --- | --- | --- | --- |
| OTP-001 | High | Production webhook was absent. | Configured it safely in production and added the explicit `npm run telegram:webhook:set` repeatable command. |
| OTP-002 | High | `.env.example` contained credential-shaped Telegram/OTP values. | Replaced all secret-shaped example values with placeholders in the reviewed local checkout; deploy the safe example file with the source overlay. |
| OTP-003 | Medium | Bot API failures discarded Telegram HTTP status, `error_code`, description, retry hint, and timeout distinction. | Preserve these fields internally, classify timeout/network/upstream failures, and emit structured redacted diagnostics. |
| OTP-004 | Medium | A database failure while writing `delivery_status=sent` after Telegram accepted a message marked the challenge failed. | Keep the OTP pending/valid when only the post-send audit write fails; log the state as unconfirmed. |
| OTP-005 | Medium | OTP delivery/verification diagnostics were unstructured and sparse. | Add structured events without token, OTP, password, or raw request-body logging. |
| OTP-006 | High | Runtime dependency graph has 27 audit advisories (2 critical, 17 high). | Not upgraded in this focused fix; requires a separate dependency upgrade and regression cycle. |

## Existing controls verified

- OTP uses `crypto.randomInt`, HMAC-SHA256 storage, a 60-second expiry, and a
  five-attempt limit.
- Challenge IDs and deep-link tokens are opaque and stored as hashes.
- PostgreSQL uses row locks for verification reservation and marks a successful
  challenge used atomically.
- Foreign Telegram contacts are rejected before OTP generation.
- Webhook requests require a timing-safe secret-token comparison.
- Legacy phone OTP endpoints remain fail-closed and do not accept universal
  `0000`.

## Tests and production checks

- Local backend suite: **155/155 passed**.
- Changed JavaScript files passed `node --check`.
- Bot API mock tests cover success, upstream rejection, timeout, and redacted
  logs.
- OTP tests cover valid/invalid/used flows, rate limiting, phone binding, and
  post-send delivery-status persistence failure.
- Production Telegram `getMe`: **ok=true**, expected bot identity.
- Production webhook configuration: **success**; `hasUrl=true`, pending
  updates `0`, no Telegram last error.
- Production webhook route smoke test: missing secret `403`, valid secret `200`.
- Production PostgreSQL schema: `telegram_auth_challenges` exists with the
  required hash, status, expiry, binding, and delivery fields. The safe route
  smoke did not send an OTP or alter existing challenge rows; the request-code
  smoke only created a normal short-lived deep-link challenge.

## Remaining verification

No real test-account chat ID was available, so no OTP was sent to a user and no
real code was entered. The final end-to-end check must be performed by the
owner with the intended test account: request a deep link in the app, press
Start in `@shafotp_bot`, share the Telegram contact, receive the six-digit OTP,
and verify it in the app. Do not use a random production user.

## Deployment record

The production token was rotated earlier at the owner's request and the API
process was restarted. The webhook was then configured without deleting pending
updates. Source changes from this audit were overlaid from the reviewed local
backend checkout, the API process was restarted, and the dashboard process was
left untouched. The server-side backup is
`/var/backups/api.bradobrey.uz-telegram-otp-pre-20261019.tgz`.
