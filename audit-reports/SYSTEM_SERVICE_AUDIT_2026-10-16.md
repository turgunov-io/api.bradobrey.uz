# Сервисный аудит Bradobrey — 2026-10-16

## Краткий вывод

Система сейчас **частично работоспособна, но не готова к подтверждённой production-оценке и безопасному масштабированию**. Публичный API отвечает (`GET /health` → HTTP 200), локальный backend suite проходит 108/108 тестов. Это подтверждает живость процесса и корректность ряда изолированных контрактов, но не подтверждает доступность PostgreSQL, актуальность production-схемы, работу реальных пользовательских сценариев или соответствие выложенного кода `main`.

Оценка сервисной готовности: **4/10**. Это оценка операционной готовности по доступным данным, а не оценка пользовательского опыта на реальном устройстве. Главные причины низкой оценки: два критических публичных endpoint-а, неатомарные финансовые/booking потоки, неизвестные версия и схема в production, отсутствие проверенной готовности БД и восстановления из резервной копии.

## Что проверено

- Исходный код API и текущие проектные документы, история Git, состав зависимостей и соседние приложения Barber, Kiosk, Marketplace и Dashboard (статический обзор).
- `npm test`: **108 passed, 0 failed**. Во время suite один модуль попытался обратиться к локальной PostgreSQL (`127.0.0.1:5432`) и получил `ECONNREFUSED`; тестовый процесс это обработал, поэтому результат suite остался успешным.
- `npm run test:integration` не запускался: `MARKETPLACE_INTEGRATION` выключен. PostgreSQL миграции и реальные транзакции этим аудитом не подтверждены.
- `npm audit --omit=dev`: **27 advisories** — 2 critical, 17 high, 7 moderate, 1 low. Часть уязвимостей относится к PM2/tooling поддеревьям; требуется reachability-триаж. В том числе обнаружен critical advisory в `proxy-addr`, зависимости Express.
- Один read-only запрос к `https://api.bradobrey.uz/health` вернул HTTP 200 и `status=ok`.
- Production PostgreSQL, PM2, reverse proxy, логи, резервные копии, мобильные устройства и пользовательские mutation-сценарии не проверялись. SSH/deployment доступ в имеющихся заметках отмечен как недоступный.
- Значения секретов не читались. В Git не отслеживаются `.env` и локальный Firebase service-account файл; `.env` присутствовал в истории Git. Ротация исторических ключей и текущего локального service credential не подтверждена.

## Система по сервисным потокам

| Поток | Текущее устройство | Состояние по аудиту |
|---|---|---|
| Barber login / сессия | JWT, branch context; heartbeat присутствия каждые 30 секунд; приложение завершает сессию на локальной полуночи | API presence/logout улучшены; причина logout примерно через 30 минут не установлена. Полуночный выход зависит от часового пояса/часов телефона. Production 401 логи недоступны. |
| Очередь / передача барбера | PostgreSQL queue entries, переходы статусов, transfer history, Socket.IO по филиалу | Для ряда переходов есть CAS/idempotency и тесты. В приложении Barber не подтверждена REST-сверка после долгого обрыва сокета; UI может устареть до следующей синхронизации. |
| Kiosk / бронирование | API `/api/kiosk/book`, локальный кеш и socket roster; heartbeat работников влияет на видимость | Сервер умеет принимать `idempotency_key`, но Kiosk-клиент не передаёт ключ: потерянный ответ и повтор могут создать дубль. Проверка сертификата клиентом отправляет GET с JSON body; контракт следует согласовать. |
| Marketplace booking | отдельный marketplace контракт с `Idempotency-Key`; клиент сохраняет ключ при неоднозначной сетевой ошибке | Клиентская идемпотентность сильнее kiosk-потока. Backend одиночное бронирование всё ещё не является одной DB-транзакцией; событие может уйти до завершения всех записей. PostgreSQL integration не выполнен. |
| Оплата / лояльность | cashback/referral/points ledgers и marketplace payment contracts | Критичный financial release risk: завершение заказа, payment rows, loyalty и settlement не везде объединены в атомарную финансовую операцию; расчёты комиссии и Payme/Click не подтверждены как готовый production flow. |
| Реальное время | Socket.IO с JWT или kiosk ticket и branch authorization | В текущем backend-коде handshake и branch scope защищены. Старое Security замечание об анонимном room join не подтверждается текущим кодом; production версия не установлена. |
| Dashboard | Nuxt SSR/proxy к backend; статически проверенные auth guards и forwarder-ы | Функциональный путь правдоподобен по коду, но end-to-end login, права и mutation сценарии не проверялись. |

## Findings по приоритету

### P0 — закрыть до дальнейшего публичного использования соответствующих функций

1. **Публичная регистрация привилегированной роли.** `POST /api/barbers/register` подключён без route-level auth, а `register()` принимает роль из body и разрешает `admin`. Глобальный `enforceEmployeeAccess` пропускает запросы без Bearer token. Это позволяет внешнему клиенту попытаться создать административную учётную запись при доступной БД. Свидетельства: `src/routers/barbers.js:15-16`, `src/middleware/employeeAccess.js:51-57`, `src/models/barbers.js:1975-2019`.

2. **Публичная загрузка баннеров с 5 ГБ в RAM.** `POST/PUT/PATCH /api/marketplace/banners` не защищены авторизацией в router; `multer.memoryStorage()` допускает файл до 5 GiB. Риск исчерпания памяти/отказа API и несанкционированного изменения контента. Свидетельства: `src/routers/marketplace/banner.js:5-20`.

### P1 — высокий риск целостности и доступности

3. **Готовность API маскирует проблемы PostgreSQL.** `/health` всегда возвращает `status=ok`, не делая DB/readiness probe. Live HTTP 200 подтверждает только доступность HTTP процесса. Свидетельства: `src/app.js:72-80`.

4. **Нет полного graceful shutdown.** SIGTERM/SIGINT останавливают локальные расписания, но не закрывают HTTP/Socket.IO server и PostgreSQL pool; не видны drain in-flight requests и bounded timeout. При restart возможны оборванные запросы и принудительное завершение. Свидетельства: `src/server.js:150-167`.

5. **Одиночное Marketplace бронирование и финансы не полностью атомарны.** Queue entry, marketplace booking/person rows, событие и downstream ledger writes выполняются несколькими шагами с компенсацией. Ошибка посередине может оставить частично записанные сущности/события. Для group booking транзакционный путь лучше. Сверить критичные точные ветви перед исправлением и закрыть PostgreSQL concurrency тестами.

6. **Kiosk не отправляет поддерживаемый сервером ключ идемпотентности.** Повтор пользователя после сетевого таймаута может создать второй заказ: backend принимает `idempotency_key` (`src/models/kiosk.js:611, 741, 1028-1050`), но текущий kiosk remote datasource его не передаёт. Добавить устойчивый клиентский ключ и обработку неопределённого результата.

7. **Актуальная production-схема и code SHA не подтверждены.** Health 200 не показывает commit, DB schema version или состояние миграций. Локальные DB credentials ранее не проходили аутентификацию; integration test выключен.

8. **Не доказана восстановимость данных.** В репозитории/проектных заметках нет подтверждения регулярной PostgreSQL backup policy, RPO/RTO или успешного restore drill. До проверки восстановление считать непроверенным.

9. **Зависимости.** У `npm audit --omit=dev` 2 critical и 17 high. Среди критических: `proxy-addr` в runtime-графе Express и `basic-ftp` под PM2 agent. Нужны обновление lockfile и повторный audit; PM2/tool-only finding сначала проверить на фактической production установке/использовании.

10. **Операционная наблюдаемость слаба.** В package scripts нет CI, lint/typecheck/coverage gate; `build` no-op. Не подтверждены структурированные метрики/алерты для DB pool, API 5xx, Socket.IO клиентов, расписаний, push/Telegram и миграций.

### P2 — клиентская устойчивость и эксплуатационная зрелость

11. Barber App делает logout на каждый HTTP 401; источник кратковременных 401 не установлен. Выход на локальную полночь делает срок сессии непредсказуемым для вошедшего после полуночи пользователя.

12. Marketplace сохраняет auth session в SharedPreferences, а не в системном secure storage.

13. Kiosk certificate validation использует GET с JSON body; некоторые прокси/клиенты могут отбросить body. Подтвердить контракт на backend и заменить на надёжный POST/query контракт.

14. PM2 config минимален; фактическое число worker-ов и включён ли cluster mode неизвестно. В API есть process-local schedulers/таймеры; масштабирование на несколько процессов может привести к повторной фоновой работе, а рестарт теряет volatile timers.

## Что уже работает хорошо по коду

- Локальная ветка чистая и совпадает с `origin/main`; последний commit `3ed4159`.
- Backend suite покрывает auth/branch scope, статусы очереди, presence transaction rollback, Telegram OTP и часть employee-quality contract-ов; 108 тестов прошли.
- Kiosk presence отфильтровывает работников без свежего heartbeat; backend logout обновляет две presence-таблицы транзакционно (по текущим тестам/докам).
- Socket.IO сейчас требует подписанный employee JWT либо короткий kiosk ticket, ограничивает branch join и отключает сессию по истечении JWT.
- Marketplace клиент сохраняет idempotency key после неоднозначного booking ответа.

## Приоритетный план

1. Немедленно закрыть регистрацию админ-роли и баннерные mutation/upload endpoints: явная auth+RBAC allowlist, малый лимит, streaming/persistent storage и проверка типа содержимого. Провести негативный regression matrix.
2. Установить фактическую production версию: read-only deploy/PM2 snapshot, schema inventory, DB connectivity, reverse proxy config, актуальные error logs и deployment SHA. Не считать `/health` достаточным.
3. Ввести DB readiness, graceful shutdown с drain/timeout, наблюдаемость и CI gate.
4. Обновить зависимости, начиная с критических runtime advisories; зафиксировать lockfile и повторно проверить deploy image.
5. Исправить kiosk idempotency на клиенте; PostgreSQL concurrency/integration test для booking/payment/refund/settlement и повторов.
6. Подтвердить backup schedule и выполнить документированный restore drill на staging; закрепить RPO/RTO и migration rollback strategy.
7. Выполнить реальные smoke journeys для Barber login/heartbeat/logout, kiosk booking/certificate, marketplace booking/cancel/payment, dashboard authorization; затем проверить push/Telegram и мобильный release.

## Ограничение вывода

Аудит отделяет наблюдаемое от предполагаемого: HTTP API отвечает, код и локальные unit/contract tests проверены, но реальные пользователи, DB, деплой, резервные копии, reverse proxy, мобильные сборки и внешние провайдеры не проверялись. Поэтому текущая фактическая работа production-системы остаётся **неизвестной за пределами доступности health endpoint**.
