# BRADOBREY Marketplace — ТЗ gap-аудит

Дата проверки: 2026-09-23

Документ основан на предоставленном prompt-наборе ТЗ и текущем коде Flutter marketplace (`D:\bradobrey_marketplace`) и API (`D:\api.bradobrey.uz`).

| Область | Статус | Реализация / доказательство | Остаток |
|---|---|---|---|
| Email/Gmail sign in и регистрация | DONE (code/config) | Email OTP при регистрации, email+password login, JWT, rate limit; phone OTP оставлен только для legacy/optional profile linking | Нужна runtime smoke-проверка SMTP и email OTP |
| Одна активная бронь | DONE (после миграции) | Partial unique index + транзакционные проверки | Применить миграцию PostgreSQL |
| Group booking 1–4 persons | DONE (после миграции) | `groupBooking.js`, person/service tables, idempotency, aggregate queue trigger waits for every person to reach terminal state | Нужен integration test на реальной БД |
| 1–3 услуги и лимит 180 минут | DONE | Backend validation + platform settings | Нужен integration test |
| До закрытия филиала | DONE | Timezone-aware schedule validation | Нужен integration test с расписанием |
| Общая очередь kiosk/marketplace | DONE | Shared `queue_entries`, same statuses and queue snapshot | Проверить после миграции |
| Live queue / realtime | PARTIALLY DONE | Marketplace follows the kiosk live-queue contract: same branch room and `queue:update` wake-up, explicit call event, reconnect + rejoin, called/swapped entries remain visible, no-show and barber-change updates, lifecycle/shift/break events; `/compliance/active` returns queue position, service names and ETA minutes with in-progress remainder; Flutter screen refreshes on socket events and polls as recovery | Need runtime Socket.IO smoke test |
| Cashback / status_points separation | DONE (после миграции) | Separate wallet/ledgers and status ledger; marketplace cashback percentage resolves from configured loyalty level while legacy kiosk clients retain fallback config; status-point daily cap is serialized per client to prevent concurrent completions exceeding the limit; late-cancel/no-show level changes emit `LEVEL_CHANGED` | Need DB reconciliation run |
| Cashback atomicity | DONE | Transactional earn/spend/reversal; earn amount is capped by recorded cash/card payments and excludes certificate portions; cancelling an active marketplace booking reverses spend transactions for every group queue entry idempotently | Need production schema check |
| Cashback reconciliation | DONE (после миграции) | Periodic scheduler plus network-admin API compare wallet balance to immutable ledger and open/resolve discrepancy alerts idempotently | Apply migration and verify scheduler against production DB |
| Cashback settlement | DONE (after migration) | `cashback_settlements` schema, `/api/finance/cashback-settlements` transactional `PENDING -> SETTLED/REVERSED` admin API, branch scope, idempotent terminal transitions and audit log | Apply migration and run DB integration/reconciliation checks |
| Loyalty levels | DONE (после миграции) | Platform-configured levels and level notification | Need DB integration test |
| Referral code / expiry / money-only bonus | DONE (после миграции) | Registration-only binding, settings expiry, completion trigger plus idempotent payment-aware recovery settler | Apply migration and verify scheduled recovery against production DB |
| Referral fraud limits | DONE (after migration) | Daily limit, IP/device alert, row lock, admin review API at `/api/marketplace/admin/fraud-alerts` with `OPEN/REVIEWED/DISMISSED` state and audit trail | Apply migration and run DB access-control checks |
| Reviews | DONE (после миграции) | Completed-only, one per booking, idempotency, comment UI | Need integration test |
| Notifications inbox | DONE (после миграции) | Read/unread API and Flutter screen | Push provider credentials required |
| Push delivery | PARTIALLY DONE | Outbox dispatcher + optional webhook adapter, Asia/Tashkent quiet-hours policy for marketing types, atomic outbox claim/retry and delivery deduplication; Flutter FCM/APNs token bridge posts to `/compliance/push-tokens`; queue trigger emits bounded `ALMOST_YOUR_TURN` notifications for positions 1–2; Verifix shift start/break end emits deduplicated `BARBER_READY` notifications; successful cashback earn emits deduplicated `CASHBACK_EARNED`; marketplace-scoped promo creation targets `PROMO_FROM_SHOP` only to clients with a shop origin | Add Firebase platform files/credentials and run device delivery smoke test |
| Security / rate limiting / audit | PARTIALLY DONE | JWT, account-aware limits, failed-login audit, request audit, request-id and baseline security headers (`nosniff`, frame/referrer/permissions policies, HSTS in production), explicit `TRUST_PROXY` gate, threat model; single marketplace bookings through the shared kiosk endpoint now also write `marketplace_audit_logs` with request id | Need external security review and DB audit verification |
| Flutter screens | PARTIALLY DONE | Email/Gmail-oriented auth routing with email OTP registration and password login; phone auth is no longer exposed as the sign-in/sign-up entry flow. Live active booking (including bookings created at kiosk), API-backed barbershop list with search, referrals with sharing, notifications, cancel/review, cashback wallet, status-points loyalty display, localization, native token bridge, blocked-account booking guard while read-only screens remain available | Maps/native push need device integration verification |
| Automated tests | PARTIALLY DONE | Flutter 52 tests; API 22 tests, including settings, security headers, compliance module loading and migration contract invariants; added `npm run test:integration` real-PostgreSQL schema/lock smoke suite | Integration suite is intentionally skipped until `MARKETPLACE_INTEGRATION=1` and valid database credentials; full concurrency/e2e run remains pending |

## Deployment gate

- Android release/debug builds require JDK 11+ (JDK 17 recommended); the current
  workstation exposes only Java 8, so Gradle cannot resolve the Flutter/Firebase
  plugin graph until `JAVA_HOME` points to a compatible JDK.
- PostgreSQL migration execution remains pending until valid database
  credentials are supplied.
- Once credentials are fixed, apply and verify the compliance schema with
  `npm run db:marketplace:apply`; the runner uses a transaction, advisory lock
  and required-table/index preflight.
- Native FCM/APNs delivery remains pending until platform Firebase credentials
  are added and a device smoke test is run.

The compliance migration has not been applied in this environment. The configured PostgreSQL connection currently returns `password authentication failed for user "bradobrey_user"`. Until credentials are corrected, schema-dependent items cannot be marked fully verified.
