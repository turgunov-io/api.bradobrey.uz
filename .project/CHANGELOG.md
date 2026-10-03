# Changelog

## 2026-10-03

- Унифицирован active queue contract между `GET /api/barbers/queue` и `GET /api/kiosk/barbers/:branch_id`: `waiting/called/swapped/in_progress`.
- Личная очередь барбера теперь возвращает `swapped`; Kiosk больше не включает terminal/transfer-pending записи в clients и ETA.
- Добавлены endpoint-level contract-тесты очереди; полный backend suite проходит 41/41.
- Проведён полный read-only аудит backend API на соответствие ТЗ маркетплейса.
- Выполнены security, auth/RBAC, queue/booking, DB/migration, loyalty/payment, realtime/push, QA и operations проверки.
- Зафиксированы P0/P1 findings, release acceptance suite и remediation backlog.
- OTP `0000` зарегистрирован как временно принятое исключение только до подключения SMS; для production оставлен обязательным release gate.
- БД и deployment не изменялись.
