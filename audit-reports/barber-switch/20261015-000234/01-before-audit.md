# До-аудит: смена барбера

Дата аудита: 2026-10-15 00:02 Asia/Tashkent
Репозиторий: `api.bradobrey.uz`, ветка `main`, HEAD `de66ce8`

## Исходное состояние

- Backend: Express 5, PostgreSQL через `src/config/postgres.js`, Socket.IO.
- Flutter/Dashboard исходники в этом репозитории отсутствуют; клиентский контракт проверен по README и backend routes/tests.
- Документированный API: `GET /api/barbers/queue/:id/reassign-options` и `PATCH /api/barbers/queue/:id/reassign`.
- Ветка чистая, upstream: `origin/main`.
- Последние commits уже содержат исправление unreachable-code в `reassignQueue` и миграцию active employee branches, но runtime DB-проверка ранее не была доступна.

## Трассировка сценария

1. `src/routers/barbers.js:29-30` принимает options/reassign.
2. `src/models/barbers.js:261-285` проверяет Bearer JWT и workspace role.
3. `src/models/barbers.js:2652-2783` выбирает запись, кандидатов, обновляет `queue_entries` и отправляет Socket.IO события.
4. `src/models/barbers.js:1109-1214` строит доступных кандидатов.
5. `src/models/kiosk.js:360-425` уже учитывает `employee_active_branches` для временно выбранного филиала; reassign-код использовал только `barbers.branch_id`.

## Найденные проблемы

### BS-001 — High

- Файл/строки: `src/models/barbers.js:2664-2675`.
- Фактическое поведение: при наличии `branchId` в JWT любой workspace-сотрудник того же филиала мог изменить чужую запись.
- Ожидаемое поведение: смену инициирует только назначенный барбер; это также требование задачи и контракт transfer workflow.
- Доказательство: запрос фильтруется только по `id` и `branch_id`, а `.eq('barber_id', auth.barberId)` применяется лишь для legacy JWT без branch claim.
- Влияние: обход ownership/access-control и изменение очереди другого сотрудника.

### BS-002 — High

- Файл/строки: `src/models/barbers.js:1110-1135`.
- Фактическое поведение: кандидаты выбираются по `barbers.branch_id`; барбер, работающий во временно выбранном филиале через `employee_active_branches`, не попадает в список.
- Ожидаемое поведение: доступный on-shift барбер текущего филиала должен быть кандидатом независимо от постоянного/home branch.
- Доказательство: kiosk path уже делает merge по `employee_active_branches` (`src/models/kiosk.js:370-425`), а reassign path такого запроса не выполняет.
- Влияние: пустой список кандидатов или общее 500/400-сообщение в UI при валидной смене филиала.

### BS-003 — Medium

- Файл/строки: `src/models/barbers.js:2667-2745`.
- Фактическое поведение: чтение, расчёт хвоста и update выполняются отдельными pool-запросами без row lock и без транзакции.
- Ожидаемое поведение: конкурентная смена должна быть compare-and-set/атомарной и не перезаписывать уже изменённую запись.
- Доказательство: используется обычный query-builder `db.from(...).select/update`, а не transaction client; update лишь фильтрует статус.
- Влияние: race condition, потеря очередности или несогласованное событие при двух запросах.

