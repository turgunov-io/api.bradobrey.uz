# Project memory

## Долговременные факты

- Backend использует Express, PostgreSQL и Socket.IO; Marketplace и kiosk объединены через legacy `queue_entries`.
- В queue Marketplace сейчас кодируется как `source='site'`, а в marketplace booking используется `MARKETPLACE`. Это текущая совместимость, но контракт нужно нормализовать и документировать.
- Group booking реализован транзакционно; single booking на 2026-10-03 неатомарен.
- Payment completion/ledger и cashback settlement semantics также неатомарны и не соответствуют финансовой модели ТЗ; не доверять существующим отметкам `DONE` без DB integration evidence.
- Marketplace migration хранится в `db/postgres/marketplace_tz_compliance.sql`; фактическая применённость в runtime DB не подтверждена.
- OTP `0000` согласован владельцем только как временный режим без SMS. Никогда не считать его production-ready.
- `.env` сейчас игнорируется, но ранее был в Git history. Не хранить секреты или их значения в документации.
- `firebase-service-account-new.json` локально игнорируется и на момент аудита не отслеживался Git.
- Существующий корневой `MARKETPLACE_TZ_AUDIT.md` переоценивает atomicity single booking/cashback и push delivery; актуальный аудит находится в `.project/API_TZ_COMPLIANCE_AUDIT.md`.
- Канонический активный queue contract для Barber и Kiosk: `waiting`, `called`, `swapped`, `in_progress`. `cancelled`, `rejected`, `transfer_pending`, `completed`, `no_show`, `not_in_time` не должны попадать в клиентскую активную очередь или ETA.
- Kiosk availability не должна выводиться из нулевого ETA: authoritative `is_available` истинно только для active/on-shift барбера без active queue. Незавершённый `in_progress` всегда блокирует доступность и даёт минимум 1 минуту ETA даже после превышения плановой длительности.
- Полная цепочка назначения queue entry читается из `queue_status_events` и `queue_transfer_events` через `/api/barbers/queue/:id/barber-history`; ответ намеренно не содержит client PII или transfer reason.
- Service edits после старта поддерживаются через `edit-before-complete` (`service_ids`/`add_service_ids`) и общий queue PATCH; ответы содержат services/total duration/total price и публикуют `queue_updated`.
- No-show endpoint owner-scoped, status-guarded и идемпотентный; успешные явные и автоматические no-show transitions публикуют `queue:update`.
- Active Barber `GET /api/barbers/queue` возвращает PII-free `transfer_history` с именами from/to барберов, потому что Barber UI строит цепочку назначений прямо из queue item. `not-in-time` использует те же owner/status/concurrency/idempotency/realtime гарантии, что и no-show.

## Проверенные команды (2026-10-03)

- `npm test`: 46/46 pass.
- `npm run test:integration`: test skipped без `MARKETPLACE_INTEGRATION=1`.
- `node --check`: 106 JS-файлов pass.
- `npm run build`: no-op, не является quality gate.
- `npm audit --omit=dev`: 25 vulnerabilities (1 critical, 17 high, 6 moderate, 1 low).
- App load дошёл до DB и получил authentication failure; живое поведение схемы не проверено.
