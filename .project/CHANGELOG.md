# Changelog

## 2026-10-03

- Kiosk barber availability теперь явно возвращает busy/available state; незавершённый overdue `in_progress` не превращается в свободного барбера и продолжает блокировать ETA.
- Добавлен защищённый PII-free `GET /api/barbers/queue/:id/barber-history` с original → accepted transfers → current chain и status audit.
- Queue service edits после старта валидируют услуги, возвращают `services/total_duration/total_price` и публикуют realtime `queue_updated`.
- No-show transition получил JWT ownership, status/concurrency guards, идемпотентные retries и `queue:update` notifications.
- Focused queue tests расширены до ETA/availability, service edit, no-show и transfer-history contracts; полный suite проходит 45/45.
- Active Barber queue теперь включает ordered PII-free `transfer_history` с from/to barber names; `not-in-time` endpoint защищён ownership/status/concurrency guards, идемпотентностью и realtime notification. Полный suite проходит 46/46.
- Унифицирован active queue contract между `GET /api/barbers/queue` и `GET /api/kiosk/barbers/:branch_id`: `waiting/called/swapped/in_progress`.
- Личная очередь барбера теперь возвращает `swapped`; Kiosk больше не включает terminal/transfer-pending записи в clients и ETA.
- Добавлены endpoint-level contract-тесты очереди; полный backend suite проходит 41/41.
- Проведён полный read-only аудит backend API на соответствие ТЗ маркетплейса.
- Выполнены security, auth/RBAC, queue/booking, DB/migration, loyalty/payment, realtime/push, QA и operations проверки.
- Зафиксированы P0/P1 findings, release acceptance suite и remediation backlog.
- OTP `0000` зарегистрирован как временно принятое исключение только до подключения SMS; для production оставлен обязательным release gate.
- БД и deployment не изменялись.
