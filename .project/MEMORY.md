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

## Проверенные команды (2026-10-03)

- `npm test`: 41/41 pass.
- `npm run test:integration`: test skipped без `MARKETPLACE_INTEGRATION=1`.
- `node --check`: 106 JS-файлов pass.
- `npm run build`: no-op, не является quality gate.
- `npm audit --omit=dev`: 25 vulnerabilities (1 critical, 17 high, 6 moderate, 1 low).
- App load дошёл до DB и получил authentication failure; живое поведение схемы не проверено.
