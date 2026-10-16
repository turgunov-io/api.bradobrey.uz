# QA-аудит выхода приложения барбера

Дата: 2026-10-15, Asia/Tashkent
Область: backend `api.bradobrey.uz`, Flutter `bradobrey_barber`, kiosk presence contract.

## Итог

Заявленная политика сейчас реализована не полностью:

1. JWT в локальной backend-конфигурации живёт `12h`, а не 15 часов (`.env: JWT_EXPIRES_IN=12h`; fallback в `src/models/barbers.js:144` также `12h`).
2. Flutter действительно планирует logout на первое локальное 00:00 после входа (`lib/core/services/midnight_logout_service.dart:41-96`) и повторяет проверку при возврате из background.
3. Любой HTTP 401 немедленно очищает локальную сессию (`barber_remote_data_source.dart:123-140`, `presence_service.dart:61-64`). Поэтому выход через 30 минут не объясняется штатным JWT TTL и, если не совпадает с 00:00, требует production 401/PM2/nginx evidence.
4. Production фактический `JWT_EXPIRES_IN`, `JWT_SECRET`, PM2 logs и deployed client/backend commit проверить не удалось: SSH access unavailable. Public `/health` 200 подтверждает только liveness.

