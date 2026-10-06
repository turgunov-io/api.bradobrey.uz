# Project memory

- For Statistics/History authorization, an empty `user_permissions` result on `admin`/`admin_network` means no per-user permissions were provisioned and resolves to the full admin preset; non-empty rows remain explicit overrides.

## Долговременные факты

- Backend использует Express, PostgreSQL и Socket.IO; Marketplace и kiosk объединены через legacy `queue_entries`.
- В queue Marketplace сейчас кодируется как `source='site'`, а в marketplace booking используется `MARKETPLACE`. Это текущая совместимость, но контракт нужно нормализовать и документировать.
- Group booking реализован транзакционно; single booking на 2026-10-03 неатомарен.
- Payment completion/ledger и cashback settlement semantics также неатомарны и не соответствуют финансовой модели ТЗ; не доверять существующим отметкам `DONE` без DB integration evidence.
- Marketplace migration хранится в `db/postgres/marketplace_tz_compliance.sql`; фактическая применённость в runtime DB не подтверждена.
- Универсальный OTP `0000` удалён из backend; phone auth проходит через
  собственного Telegram Bot с одноразовым deep-link onboarding.
- `.env` сейчас игнорируется, но ранее был в Git history. Не хранить секреты или их значения в документации.
- `firebase-service-account-new.json` локально игнорируется и на момент аудита не отслеживался Git.
- Существующий корневой `MARKETPLACE_TZ_AUDIT.md` переоценивает atomicity single booking/cashback и push delivery; актуальный аудит находится в `.project/API_TZ_COMPLIANCE_AUDIT.md`.
- Канонический активный queue contract для Barber и Kiosk: `waiting`, `called`, `swapped`, `in_progress`. `cancelled`, `rejected`, `transfer_pending`, `completed`, `no_show`, `not_in_time` не должны попадать в клиентскую активную очередь или ETA.
- Kiosk availability не должна выводиться из нулевого ETA: authoritative `is_available` истинно только для active/on-shift барбера без active queue. Незавершённый `in_progress` всегда блокирует доступность и даёт минимум 1 минуту ETA даже после превышения плановой длительности.
- Полная цепочка назначения queue entry читается из `queue_status_events` и `queue_transfer_events` через `/api/barbers/queue/:id/barber-history`; ответ намеренно не содержит client PII или transfer reason.
- Service edits после старта поддерживаются через `edit-before-complete` (`service_ids`/`add_service_ids`) и общий queue PATCH; ответы содержат services/total duration/total price и публикуют `queue_updated`.
- No-show endpoint owner-scoped, status-guarded и идемпотентный; успешные явные и автоматические no-show transitions публикуют `queue:update`.
- Active Barber `GET /api/barbers/queue` возвращает PII-free `transfer_history` с именами from/to барберов, потому что Barber UI строит цепочку назначений прямо из queue item. `not-in-time` использует те же owner/status/concurrency/idempotency/realtime гарантии, что и no-show.
- Канонический рейтинг сотрудников — `employee-quality-v1` в `src/services/employeeQuality.js`. Revenue не является ranking key; suspicious сравнивается до productivity; generic legacy cancellations нейтральны.
- `queue_quality_assessments` хранит completion snapshots, а `queue_quality_plan_snapshots` — неизменяемые версии service-duration evidence. Backfill всегда `approximate` и не даёт official rank. Live completion без start/service snapshot также `approximate`.
- Quality migration stamps `started_at`/`finished_at` with PostgreSQL `now()` on transitions into `in_progress`/`completed`; client timestamps cannot influence v1 classification or period inclusion.
- Plan snapshot versions фиксируют timestamp и controlled reason; actor пока `NULL`, пока queue service-edit routes не переведены на authenticated transactional attribution.
- Statistics/History используют DB `user_permissions` как authoritative source, включая пустой набор. Разрешение review отделено: `statistics.quality.review`.
- Quality/statistics permissions авторизуются только по `user_permissions`, а login/me всегда возвращают этот authoritative набор. Для пользователей, существовавших до rollout, есть одноразовый marker-protected role-compatible backfill; после marker ручной отзыв права не восстанавливается повторным schema run. Новые пользователи получают явный набор через административный workflow.
- Audit tables сохраняют raw UUID без FK cascade/SET NULL. Plan/review/status events append-only, а completion assessment разрешает менять только review projection fields.
- Status routes пока не передают достоверного actor/reason в одной транзакции; поэтому новые generic cancellation events намеренно остаются `actor_type=unknown` и не считаются employee failures.
- В схеме нет `network_id`; `statistics.read.global` допустим только при single-network-per-database deployment.
- `barbers.is_active` используется для короткого перерыва/availability и не является кадровым статусом; eligibility качества зависит от `is_archived`, а не от `is_active`.
- Manager Statistics и suspicious Notifications обязаны предпочитать persisted `queue_quality_assessments`; отсутствие assessment допускает только явно `approximate` runtime fallback по текущему каталогу.
- Generic queue PATCH не может менять terminal status, услуги или payment method и использует compare-by-previous-status guard. Повтор того же terminal status — read-only idempotent no-op. Audited employee/branch hard deletion блокируется; используйте archive/deactivate.
- Dedicated queue completion допускает только `in_progress → completed`; повтор `completed` остаётся idempotent recovery path, а DB update обязательно сравнивает ранее прочитанный status, чтобы не перезаписать конкурентный terminal transition.
- Assessment review projection обновляется только при наличии matching append-only review event. Для production всё равно требуется отдельная migration/owner DB role с `GRANT/REVOKE`, чтобы HTTP runtime role не владел audit objects.

## Проверенные команды (2026-10-03)

- `npm test`: 46/46 pass.
- `npm run test:integration`: test skipped без `MARKETPLACE_INTEGRATION=1`.
- `node --check`: 106 JS-файлов pass.
- `npm run build`: no-op, не является quality gate.
- `npm audit --omit=dev`: the current local install reports 27 vulnerabilities
  (2 critical, 17 high, 7 moderate, 1 low). This remains an existing
  dependency-release risk and was not auto-fixed because the suggested forced
  upgrades include breaking PM2/Nodemailer changes.
- App load дошёл до DB и получил authentication failure; живое поведение схемы не проверено.

## Проверенные команды (2026-10-04)

- `npm test`: 70/70 pass, включая employee-quality boundary/ranking/permission/migration tests, authoritative session permissions, one-time permission provisioning, persisted-notification snapshot mapping, generic terminal PATCH integrity и dedicated completion CAS/terminal tests.
- `node --check`: employee-quality, statistics/history integration files pass.
- Миграция подготовлена и включена в `scripts/apply-schema.sh`, но не применялась: безопасная staging PostgreSQL не предоставлена.
- Telegram marketplace auth uses the ordinary Bot API under
  `/api/auth/telegram/*` (with marketplace-prefixed aliases). Linking uses a
  five-minute opaque deep-link token; OTPs are six digits, HMAC-hashed, expire
  after five minutes, and allow five attempts. Telegram user/chat bindings are
  unique per marketplace client. Runtime verification requires the additive
  migration and Bot credentials outside Git.
- Audit 2026-10-07: the phone flow contains no Gateway/MTProto calls; webhook
  requests require `TELEGRAM_WEBHOOK_SECRET`, and duplicate `/start` delivery
  is idempotent. Local PostgreSQL connectivity still needs staging verification.
- Audit 2026-10-06: legacy backend `/api/marketplace/auth/phone/*` endpoints no
  longer issue or verify OTP and fail closed with `TELEGRAM_AUTH_REQUIRED`;
  Bot `/api/auth/telegram/*` is the only phone OTP path.
- Audit 2026-10-06: local PostgreSQL connectivity could not verify the Telegram
  auth tables because the configured `bradobrey_user` password was rejected.

## Проверенные команды (2026-10-07)

- `npm test`: 83/83 pass, including Bot onboarding, hash-only OTP, webhook
  idempotency, verification reuse protection, and Bot/Gateway contract checks.
- `node --check`: touched auth, Bot service, router, app, and migration runner
  files pass.
- `npm run build`: pass; configured project build is a no-op.
- `npm run test:integration`: skipped because `MARKETPLACE_INTEGRATION=1` and
  valid staging PostgreSQL credentials were not provided.
- `npm audit --omit=dev --audit-level=high`: existing install reports 27
  vulnerabilities; no forced dependency upgrades were applied.

## Проверка production Telegram OTP (2026-10-07)

- Live `https://api.bradobrey.uz/api/marketplace/auth/telegram/request-code`
  возвращает старый `TELEGRAM_NOT_CONFIGURED` (503), а live
  `/api/integrations/telegram/webhook` возвращает 404. Текущий checkout уже
  содержит Bot API flow и этот webhook route, поэтому production runtime не
  синхронизирован с checkout.
- В локальном production `.env` отсутствуют
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` и
  `OTP_HASH_SECRET`; значения в память не записывать. Без Bot credentials
  нельзя безопасно выполнить `getMe`, `setWebhook` или реальный smoke test.
- Public health проходит через nginx; DNS `api.bradobrey.uz` разрешается в
  `95.46.96.213`. SSH-проверка с доступным ключом для `root`, `ubuntu` и
  `admin` отклонена, поэтому live PM2/.env/nginx/DB проверить и перезапустить
  из этого checkout невозможно. Read-only PostgreSQL check также отклонён
  production DB ошибкой `28P01`.
- Удалён legacy stdout-log email OTP из
  `src/models/marketplace/auth.js`; Telegram flow уже не логирует token, OTP
  или полный request headers.
