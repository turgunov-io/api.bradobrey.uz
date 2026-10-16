# Аудит выхода из аккаунта Barber App и актуальности Kiosk

Дата: 14 октября 2026, Asia/Tashkent  
Объекты: `C:\project\bradobrey_barber`, `C:\project\api.bradobrey.uz`  
Изначальный режим: аудит. После согласования владельцем внесены исправления
в backend и Flutter-клиент; production deployment в рамках этой задачи не
выполнялся.

## Краткий вывод

Обнаружены две независимые цепочки проблем:

1. Состояние присутствия мастера хранится в двух местах (`barbers.is_on_shift` и `employee_active_branches.is_on_shift`), но logout обновляет только первое. Поэтому после выхода активная branch-запись может оставаться включённой, а kiosk продолжает видеть мастера.
2. Kiosk API намеренно возвращает всех неархивных мастеров филиала, в том числе `off_shift`; он только добавляет `availability_status=off_shift` и `is_available=false`. Это не соответствует требованию “не показывать неактивного мастера”.
3. При аварийном завершении приложения или потере сети нет надёжного серверного heartbeat/TTL присутствия. `is_on_shift=true` может остаться до ручного logout, break/смены статуса или перезапуска/ручной очистки.
4. Частый выход из аккаунта технически выполняется на любой HTTP 401: Flutter сразу очищает токен и переводит пользователя на login. JWT по умолчанию живёт 12 часов, поэтому интервал 5–10 минут не является штатным сроком действия JWT; для подтверждения конкретного источника нужны production access/error logs.

## Подтверждённые находки

### HIGH — logout не сбрасывает активную branch-сессию

Доказательства:

- login устанавливает `employee_active_branches.is_on_shift=true` через `setActiveEmployeeBranch`, затем отдельно устанавливает `barbers.is_on_shift=true` (`src/models/barbers.js:1829-1833`);
- kiosk читает `employee_active_branches` и формирует `activeById` только из записей с `is_on_shift=true` (`src/models/kiosk.js:363-371`);
- logout обновляет только `barbers` (`src/models/barbers.js:3337-3345`), не вызывая `setActiveEmployeeBranch(..., isOnShift:false)`;
- kiosk объединяет branch-список с `activeById`, поэтому stale active assignment может переопределить состояние из `barbers` (`src/models/kiosk.js:379-408`).

Следствие: после logout мастер может остаться активным в kiosk, особенно при multi-branch schema.

### HIGH — API kiosk не фильтрует неактивных мастеров

`GET /api/kiosk/barbers/:branch_id` получает всех мастеров с `branch_id`, исключает только архивных и role-недопустимых, но не исключает `is_on_shift=false` (`src/models/kiosk.js:354-408`). Далее endpoint возвращает такие записи со статусом `off_shift` (`src/models/kiosk.js:512-537`).

Следствие: даже при корректном logout UI получит мастера в массиве `barbers`; исчезновение зависит от kiosk frontend. В API-контракте заявлено `is_available`, но это флаг доступности для записи, а не фильтр отображения.

### HIGH — нет durable presence/heartbeat

В backend найден только process-local `scheduleShiftAutoOff` (`src/models/barbers.js:87-127`), причём вызовов этой функции нет. Break timer также process-local. Login ставит shift в true, а штатное снятие выполняется через logout/break/ручной endpoint.

Следствие: force-kill, crash, закрытие процесса, background restriction Android или сетевой обрыв не снимают мастера с kiosk. Это напрямую объясняет “актуальные барберы не отображаются/остаются отображаться”.

### HIGH — любой 401 выглядит для пользователя как принудительный logout

Flutter вызывает `SessionExpirationService.forceReauth()` на каждый HTTP 401 (`lib/data/datasources/barber_remote_data_source.dart:123-140`). Сервис удаляет локальную сессию и открывает login (`lib/core/services/session_expiration_service.dart:13-23`). Refresh token flow отсутствует.

Backend подписывает JWT с `JWT_EXPIRES_IN || '12h'` (`src/models/barbers.js:137-146`). Значит регулярный выход через 5–10 минут означает не штатный JWT TTL, а один из сценариев: кратковременный 401 от API/reverse proxy, неправильный/сменившийся `JWT_SECRET`, повреждённый токен в storage, старый deployment/конфигурация, либо backend rejects session after an access-state change. Сейчас клиент не различает эти причины.

Дополнительный риск: `AuthLocalDataSource.isAuthenticated()` проверяет только непустую строку токена и не проверяет `exp` (`lib/data/datasources/auth_local_data_source.dart:224-227`).

### CRITICAL — logout endpoint не scoped к текущему пользователю

`POST /api/barbers/logout` принимает `barber_id` из body и не выполняет JWT-проверку внутри handler (`src/models/barbers.js:3337-3362`). Это позволяет авторизованному/неавторизованному вызывающему потенциально изменить shift-state другого мастера, если route не закрыт отдельным middleware.

Следствие: security-риск и дополнительная причина рассинхронизации presence. Logout должен брать employee id и branch из проверенного JWT, а body `barber_id` игнорировать или валидировать на совпадение.

### MEDIUM — logout может не сгенерировать корректное событие для active branch

Verifix logout логируется с `updated.branch_id`, то есть постоянным branch из `barbers`, тогда как фактическая active branch может находиться в `employee_active_branches`. При multi-branch работе событие и realtime update могут уйти не в тот branch.

### MEDIUM — realtime contract не гарантирует исчезновение

Backend отправляет `queue:update` с `type: barber_status` при части операций. В найденном Flutter-коде это событие используется для queue refresh, но нет отдельной логики изменения списка kiosk; Flutter `getBarbers` вызывается только отдельными сценариями (например, reassignment/penalties). Исходники kiosk frontend в предоставленных двух репозиториях не найдены, поэтому его обработка socket-события не подтверждена.

## Что проверено

- Backend unit/contract suite: `npm test` — 99 тестов, 99 passed.
- Flutter static analysis: `flutter analyze` — `No issues found`.
- Production health: `https://api.bradobrey.uz/health` ответил HTTP 200; это подтверждает доступность процесса, но не корректность auth/presence flow.
- Поиск тестов показал покрытие socket auth, branch switch и queue status, но нет regression-теста на logout + `employee_active_branches` и нет теста “kiosk response excludes off_shift”.

## Что не удалось подтвердить

- Production DB rows для конкретного мастера: локальная документация фиксирует, что прямое подключение к PostgreSQL ранее не проходило; в рамках аудита destructive/credential actions не выполнялись.
- Причину конкретных 5–10 минутных 401: access/error logs reverse proxy и PM2 не предоставлены локально.
- Kiosk UI: его отдельный frontend-репозиторий не был указан, поэтому проверен API-контракт, но не фактическая фильтрация/refresh в UI.

## Рекомендуемый порядок исправлений

1. Ввести один authoritative presence service: logout/shift-end/branch-switch атомарно сбрасывают и `employee_active_branches`, и legacy `barbers`, с одним branch-scoped realtime событием.
2. Определить контракт отображения: backend должен возвращать kiosk только `is_active=true`, `is_archived=false`, `is_on_shift=true` (busy/available различать внутри этого набора), либо kiosk frontend должен гарантированно фильтровать `off_shift`. Для требования пользователя предпочтительнее серверный фильтр.
3. Добавить durable presence: `last_presence_at`/session row, heartbeat с TTL и server-side query `last_presence_at >= now()-interval`, с безопасным grace period для background/mobile сети.
4. Защитить logout JWT-scoped проверкой и покрыть тестами multi-branch и stale row.
5. Диагностировать 401: добавить безопасные correlation/request ids, HTTP status/error code и время действия JWT в client/backend logs без токенов; проверить nginx/PM2/`JWT_SECRET`/`JWT_EXPIRES_IN` на production.
6. Добавить regression tests: logout clears both presence stores; kiosk excludes off-shift; stale heartbeat disappears; socket `barber_status` refreshes kiosk immediately; transient network errors do not erase a valid local session.

## Выполненные исправления

- Logout теперь JWT-scoped, сбрасывает обе presence-записи и отправляет
  `barber_status` в постоянный и активный филиал.
- Kiosk API возвращает только on-shift мастеров с heartbeat не старше 90 секунд.
- Добавлен `POST /api/barbers/presence`; Flutter отправляет heartbeat каждые
  30 секунд и при возврате приложения на foreground.
- Flutter logout исправлен на корректный `Authorization: Bearer <token>`.
- Добавлены regression/contract tests.

## Итоговый статус

Исправления реализованы и локально проверены. Для окончательного production
закрытия остаются deployment миграционного состояния/кода и наблюдение за
реальными 401 в nginx/PM2 логах после выкладки.

## Дополнение: повторный аудит после сохранения карточки (2026-10-14)

Повторная проверка исходников backend, Barber App и фактического Flutter kiosk
установила дополнительную причину: клиент kiosk восстанавливал снимок из
кэша и при ошибке API сохранял карточки мастеров даже после истечения TTL.
TTL очищал очередь, но фильтр карточек смотрел только на `is_on_shift`.
Поэтому краткий или длительный сетевой/API сбой мог показывать уже вышедшего
барбера бесконечно.

Устранено в текущем исправлении:

- Kiosk немедленно удаляет барбера по `queue:update` типа `barber_status` с
  `is_on_shift=false`, сохраняет очищенный кэш и подтверждает состояние через
  повторный API-запрос. Ответ ранее начатого запроса не может вернуть карточку.
- На следующем шаге киоска logout-событие немедленно инвалидирует выбранного
  мастера и блокирует продолжение записи до подтверждённого доступного мастера.
- Любой устаревший snapshot полностью исключается из отображения; если запрос
  завершился ошибкой, прежние карточки больше не остаются видимыми.
- Backend сбрасывает legacy- и active-branch присутствие в одной PostgreSQL
  транзакции и отправляет событие только после commit. Ошибка любого update
  откатывает оба изменения.
- Kiosk API использует legacy fallback только при подтверждённом отсутствии
  таблицы `employee_active_branches`; ошибки колонок/прав доступа не маскируются
  показом старого состояния.
- Barber App прекращает локальный logout, если серверный запрос не подтвердил
  успех, и показывает локализованное сообщение с возможностью повторить.
  Отсутствующий локальный barber ID не мешает logout: backend использует ID из
  проверенного JWT.

Добавлены проверки немедленного status-event, сокрытия stale snapshot,
transaction commit/rollback. Результаты локальной проверки этого дополнения:
backend `npm test` — 104/104; весь kiosk Flutter suite — 39 passed; весь Barber
App Flutter suite — 46 passed; `flutter analyze` обоих приложений — без
проблем. API follow-up commit `f95a8ac` опубликован и развернут: применены
только четыре относящихся к присутствию backend-файла, создан backup
`/var/backups/api.bradobrey.uz-presence-followup-20261014.tar.gz`, перезапущен
только API PM2 process. `/health` — HTTP 200; API и dashboard остались online;
logout без токена ожидаемо вернул 401. Реальный logout с аутентифицированным
барбером и физическим kiosk не проверялся. Kiosk и Barber App commits
`5ce8cca`/`463a481` опубликованы, но мобильные обновления ещё должны пройти
подписанный release/install workflow; доступного device/release pipeline в
репозитории нет.

## Correction: explicit logout session contract (2026-10-15)

The earlier 90-second heartbeat cutoff contradicted the owner's requirement that backgrounding, force-close, screen lock, network loss, and Socket.IO disconnect must not hide an authenticated barber. The exact card-loss path was `GET /api/kiosk/barbers/:branch_id` filtering `employee_active_branches.updated_at` to the last 90 seconds; the Barber App only refreshes that diagnostic timestamp every 30 seconds and on resume. The Kiosk UI replaces its barber list with a successful API response, so once the cutoff elapsed the barber was omitted and its card disappeared.

Correction plan recorded before implementation:

1. Reuse `employee_active_branches` as the existing authoritative session record; persist a random session ID and JWT expiry at login.
2. Validate the session ID, branch, account status, and expiry on protected Barber workspace requests. Logout clears the session fields and legacy shift state in the existing transaction.
3. Make Kiosk visibility depend on active branch, valid session expiry, and account state; heartbeat and socket state are not authorization signals.
4. Refresh the Kiosk API snapshot after socket connect/reconnect and ignore stale responses or call events from another branch.
5. Apply additive schema, run backend and Flutter regressions, then verify deployment only if database and host access are available.

Implementation in this checkout now follows that plan. Production rollout is not confirmed; the API worktree has a pre-existing merge in progress with unresolved conflicts, and production PostgreSQL/SSH access must be verified. Earlier lines above record the superseded 90-second policy, not the corrected session contract.

The session lifecycle implementation also now clears expired rows at API startup and on a one-minute scheduler, with a branch-scoped `session_expired` event. Shift status updates preserve the login session; only logout, token expiry, archived-account revocation, or branch-access revocation ends access. Logout replay is idempotent and cannot clear a newer session. Kiosk consumes terminal session events, removes the card from its local cache, and prevents any in-flight stale response from restoring it. Kiosk refreshes the API list at each Socket.IO connect/reconnect.
