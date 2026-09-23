# BRADOBREY API — security threat model

## Scope

This document covers the marketplace API, the shared kiosk/marketplace queue,
employee/admin APIs, Socket.IO events, push notification outbox and uploaded
media served by `src/app.js`.

## Protected assets

- Client identity, phone OTPs, JWTs and account status/block state.
- Active bookings, queue order, no-show/cancellation history and cashback.
- Referral/fraud data, reviews and notification inbox.
- Employee credentials, branch scope, admin settings and audit events.
- Push subscription keys, webhook tokens and uploaded images.

## Main threats and controls

| Threat | Controls in code | Residual verification |
| --- | --- | --- |
| OTP brute force / SMS abuse | Marketplace auth rate limit, OTP expiry/one-time use, failed-login audit, phone normalization | Configure production SMS provider and test per-phone/provider quotas |
| Credential/token abuse | JWT validation in endpoint guards, employee access middleware, role/branch checks, no token values in logs | Rotate production JWT secret and verify expiry policy |
| Booking race / double booking | DB idempotency key, active-booking unique constraint, transaction/locking migration | Run PostgreSQL concurrency tests against production-like schema |
| Queue tampering | Server-side branch validation, authenticated employee actions, exact lifecycle events and audit trail | Socket.IO authenticated-client penetration test |
| Referral/cashback abuse | New-client-only referral, daily cap, IP/device fraud signal, separate cashback settlement states, scheduled wallet/ledger reconciliation alerts | Review fraud alerts and settlement reconciliation with real DB |
| Browser/API response abuse | Explicit `CORS_ORIGIN` is mandatory in production, request-id, `nosniff`, frame/referrer/permissions policies, HSTS in production | Verify reverse-proxy TLS and allowed frontend origins |
| Client-IP spoofing | `TRUST_PROXY=true` is opt-in; otherwise Express uses direct peer identity | Set it only when the proxy strips/replaces forwarding headers |
| Oversized payload / upload abuse | 25 MB body cap, upload route controls and static upload isolation | Add reverse-proxy body cap and malware/content validation for public uploads |
| Notification replay/noise | Outbox claim/dedup/retry, quiet hours, per-client queue-position cap | Verify provider credentials, delivery receipts and device revocation |
| Sensitive data leakage | Client-scoped queries, admin/branch guards, no-store API responses | External review of every legacy route not covered by marketplace tests |

## Deployment requirements

1. Set `CORS_ORIGIN` to the exact HTTPS frontend origins; do not rely on `*`.
2. Set a strong `JWT_SECRET`, `SMS_WEBHOOK_TOKEN` and
   `MARKETPLACE_PUSH_WEBHOOK_TOKEN`; never commit them.
3. Set `TRUST_PROXY=true` only behind a trusted proxy that overwrites
   `X-Forwarded-For`.
4. Enforce HTTPS and a reverse-proxy request body limit of at least 25 MB.
5. Apply `db/postgres/marketplace_tz_compliance.sql` and run integration and
   concurrency tests with valid PostgreSQL credentials.
6. Rotate leaked or previously shared credentials before production launch.

## Verification commands

```powershell
npm test
node --check src/app.js
node --check src/middleware/securityHeaders.js
```

The remaining release gates are environment-dependent: valid PostgreSQL
credentials, real SMS/push provider credentials, HTTPS proxy configuration and
device-level Android/iOS notification tests.
