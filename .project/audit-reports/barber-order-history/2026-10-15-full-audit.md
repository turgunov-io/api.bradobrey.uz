# Полный аудит истории заказов в приложении Barber

Дата: 15.10.2026 (Asia/Tashkent)  
Статус: аудит завершён, исправления и production-деплой в рамках этого отчёта не выполнялись.  
Область: Flutter-приложение Barber, backend `/api/history`, PostgreSQL `queue_entries`, кэш истории, API/security contract.

## 1. Итог

Причина исчезновения заказов подтверждена в коде и сравнением с реальными production-данными.

У тестовой учётной записи `test1` в production-базе найдено:

| Показатель | Значение |
|---|---:|
| Все записи `queue_entries` барбера | 57 |
| Записи, созданные в текущем месяце (октябрь 2026) | 16 |
| Записи до текущего месяца | 41 |
| Самая старая запись | 01.09.2026 18:47:29 +05 |
| Самая новая запись | 15.10.2026 04:02:15 +05 |

Реальное распределение статусов: `completed` — 38, `no_show` — 12, `not_in_time` — 6, `cancelled` — 1.

Backend `GET /api/history/barber` не отбрасывает старые месяцы и при запросе мобильного клиента с `limit=200` способен вернуть все 57 записей. После получения ответа мобильный репозиторий применяет фильтр текущего года и месяца и оставляет 16 записей. Поэтому минимум 41 заказ не отображается в истории, хотя они существуют в базе и возвращаются серверным контрактом.

Это подтверждённый дефект уровня P0 для функции истории заказов. Он полностью объясняет жалобы сотрудников о пропаже заказов и может проявляться сильнее, чем «3–4 заказа», особенно на границе месяца.

## 2. Трассировка данных

```text
PostgreSQL queue_entries
        │ 57 записей для test1
        ▼
GET /api/history/barber?limit=200&offset=0
        │ backend: все разрешённые статусы, без фильтра текущего месяца
        ▼
BarberRemoteDataSource
        │ собирает страницы, сортирует по finished/payment/created
        ▼
BarberRepositoryImpl
        │ фильтр year == now.year && month == now.month
        │ 57 → 16
        ▼
OrderHistoryPage
        │ показывает только оставшиеся записи
        ▼
локальный cache
        │ перезаписывается уже урезанным списком
```

## 3. Подтверждённая первопричина

Файл мобильного приложения:
`D:\bradobrey_barber\lib\data\repositories\barber_repository_impl.dart`

Метод `_filterHistoryItemsWithValidDates` проверяет не только валидность даты, но и принадлежность текущему месяцу. Этот метод вызывается:

1. для свежего ответа backend перед возвратом результата;
2. перед выдачей cache fallback при ошибке сети;
3. до сохранения истории в локальный cache.

Следствие: старые заказы не просто скрываются в UI — они удаляются из актуального локального снимка истории при очередном refresh. При offline fallback старые заказы уже невозможно восстановить из этого cache.

Фрагмент текущей логики:

```dart
return items.where((item) {
  final date = _resolveHistoryDate(item);
  return date != null &&
      date.year == now.year &&
      date.month == now.month;
}).toList(growable: false);
```

Фильтрация по месяцу не передаётся пользователем как явный фильтр и отсутствует в UI-контракте экрана истории. Для экрана с названием «История заказов» это невалидное неявное ограничение.

## 4. Результаты аудита по компонентам

### 4.1 Мобильное приложение

| Проверка | Результат | Риск |
|---|---|---|
| API endpoint | вызывается `/api/history/barber` | Совместимо с backend |
| Пагинация | размер страницы 200, offset увеличивается до `count` | Для 57 записей одной страницы достаточно |
| Локальная фильтрация | текущий год/месяц | **P0: 57 → 16** |
| Фильтр по barber ID | ответ дополнительно сравнивается с локальным `getBarberId()` | P1: stale/missing ID может дать пустую историю |
| Кэш | очищается и записывается заново после фильтра | P1: старые записи теряются из offline fallback |
| Ошибка сети | BLoC сначала переводит экран в loading; fallback зависит от кэша | P1: возможен временно пустой экран |
| Дубликаты | после объединения страниц нет dedup по `id` | P1: при нестабильной пагинации возможны повторы/перезапись |
| Неизвестный payload | неизвестная структура списка превращается в пустой список без диагностической ошибки | P1: silent data loss |
| Платежи | backend отдаёт `payments[]`, модель ожидает `last_payment` | P1: история суммы/метода оплаты может быть неточной, хотя это не причина исчезновения строки |

Ключевые файлы:

- `lib/data/datasources/barber_remote_data_source.dart:1164-1208,1217-1219,1344-1349` — paging и tolerant payload parsing;
- `lib/data/repositories/barber_repository_impl.dart:750-755` — cache fallback;
- `lib/data/repositories/barber_repository_impl.dart:819-830` — barber ID и фильтрация свежих данных;
- `lib/data/repositories/barber_repository_impl.dart:855-867` — ошибочный current-month filter;
- `lib/data/models/order_history_item_model.dart:21-67` — parsing order/payment fields;
- `lib/barber/pages/orders_history/orders_history_page.dart` — группировка и отображение уже отфильтрованного списка.

### 4.2 Backend API

`src/models/history.js` и `src/routers/history.js`:

- `/api/history/barber` ограничивает выдачу authenticated `barber_id`, разрешёнными статусами и `limit/offset`;
- список статусов включает `waiting`, `called`, `swapped`, `transfer_pending`, `in_progress`, `completed`, `cancelled`, `rejected`, `no_show`, `not_in_time`;
- default limit равен 50, максимальный — 200; мобильное приложение явно запрашивает 200;
- сортировка выполняется только по `created_at DESC`, без второго стабильного ключа;
- count и page читаются отдельными операциями, поэтому между страницами возможна рассинхронизация при новых заказах;
- backend возвращает `payments[]`, `status_history`, `transfer_history` и рассчитанную сумму, но mobile model не полностью использует этот контракт.

Backend не содержит текущего месячного фильтра в barber history endpoint. Поэтому источник подтверждённой потери — мобильная прослойка, а не SQL выборка этого endpoint.

### 4.3 UI

Экран истории группирует полученные строки по датам и сворачивает блок «Сегодня». Свёрнутый блок не является потерей данных: строки присутствуют в состоянии и раскрываются пользователем. Однако строки, отброшенные репозиторием, до UI не доходят.

### 4.4 Backend security finding, не являющийся причиной P0

`GET /api/history/branch` выбирает строки по `branch_id`. В текущей authorization-цепочке self-scoped пользователь получает self scope для barber endpoint, а branch handler использует branch scope. Это требует отдельного integration/security теста: барбер не должен получить branch-wide историю с PII через branch route. Finding: P1, потенциальное нарушение tenant/employee scope. В рамках аудита чтение данных не изменялось.

### 4.5 Live production smoke: employee directory

15.10.2026 выполнен anonymous read-only smoke против `https://api.bradobrey.uz`.
`GET /api/barbers` вернул HTTP 200 и employee-directory payload до
аутентификации. По исходному коду `app.use(enforceEmployeeAccess)` пропускает
запросы без Bearer token (`next()`), а `src/routers/barbers.js` регистрирует
`GET /` без отдельной authorization middleware. Ответ содержит поля
employee-directory, включая `login`, `role`, `permissions`, branch и
операционные флаги.

Finding: P1 security/privacy, отдельный от исчезновения заказов. Это не
признак падения production, но публичная выдача staff metadata должна быть
либо ограничена авторизованным scope, либо заменена на минимальный публичный
kiosk DTO без login/role/permissions.

## 5. Дополнительные риски, способные создавать «пропажи» или неверную историю

1. **Нестабильная offset-пагинация (P1).** Сортировка только по `created_at` не гарантирует порядок при одинаковых timestamp; новые записи между запросами могут привести к пропуску или дублю строки. Нужен стабильный `(created_at DESC, id DESC)` либо cursor pagination и dedup по `id` на клиенте.
2. **Смешение дат (P1).** Backend сортирует по `created_at`, mobile отображает/фильтрует по `finished_at`, затем `last_payment.createdAt`, затем `created_at`. Заказ, созданный в сентябре и завершённый в октябре, может попасть в разные месячные группы в зависимости от слоя.
3. **Тихое принятие невалидной даты (P1).** Модель принимает запись, но репозиторий отбрасывает её, если все date fields не распарсились. Нет счётчика/логирования отброшенных строк.
4. **Тихое принятие неизвестной структуры JSON (P1).** `_extractHistoryItems` возвращает пустой список вместо ошибки контракта, поэтому изменение wrapper-поля может выглядеть как «история исчезла».
5. **Сумма и платежи (P1 для финансовой достоверности).** `payments[]` не маппится в `last_payment`; UI может показать synthetic payment method/amount, а не реальное распределение платежа.
6. **Legacy `/api/history` (P1 для других экранов).** В legacy all-history retention/loyal фильтрация выполняется после pagination, а date-only bounds нормализуются не по явной Asia/Tashkent half-open семантике. Это отдельный источник неполных результатов для dashboard/branch views.

## 6. Проверки, выполненные в рамках аудита

| Проверка | Результат |
|---|---|
| Production PostgreSQL aggregate по `queue_entries` | 57 всего, 16 текущий месяц, 41 старше; read-only |
| Разбивка production по статусам | 38 completed, 12 no_show, 6 not_in_time, 1 cancelled |
| Backend test suite | 86/86 passed |
| Flutter static analysis | `flutter analyze` — no issues found |
| Flutter test suite | 48/48 passed |
| Мобильный history contract test | отсутствует |
| Backend history integration/security test | отсутствует |
| Production code/config/database mutation | не выполнялась |
| Anonymous live `GET /api/barbers` | HTTP 200; staff metadata exposure требует remediation |

Production aggregate был выполнен только на чтение. Секреты, JWT, пароли и персональные идентификаторы в отчёт не включены.

## 7. Требования к исправлению

Исправление следует выполнять отдельным изменением и затем повторно проверить production-safe способом:

- убрать неявный current-month filter; оставить только явный пользовательский date filter, если он будет добавлен в продукт;
- договориться о canonical history date (`created_at` для включения в историю либо явная бизнес-дата) и использовать её во всех слоях;
- сохранять в cache полный валидный ответ, а не уже UI-отфильтрованный срез;
- добавить dedup по `queue_entry.id`, стабильный порядок и защиту от page drift;
- сделать malformed payload/invalid date наблюдаемыми: structured log/metric и безопасная ошибка контракта, а не пустой список;
- полностью распарсить `payments[]` либо документировать совместимый fallback;
- покрыть mobile unit tests: cross-month, invalid date, missing barber ID, cache fallback, paging, duplicate IDs, payments;
- покрыть backend integration/security tests: self barber, branch manager, branch route PII scope, status completeness, count/pagination and date boundaries;
- после исправления сравнивать `DB count → API count → parsed count → rendered count` для одного и того же barber ID.

## 8. Рекомендуемый порядок remediation

1. P0: устранить current-month filtering и потерю полного cache snapshot.
2. P1: добавить mobile/backend history contract tests и observability dropped/duplicate rows.
3. P1: стабилизировать pagination/order и унифицировать date semantics.
4. P1: проверить и закрыть branch/self authorization matrix.
5. P1: выровнять payment response/model.
6. Только после зелёных тестов выполнить staged smoke, затем согласованный production deploy и повторное сравнение counts.

## 9. Вывод

Жалоба сотрудников подтверждена фактическими данными. Заказы не исчезают из PostgreSQL: мобильное приложение сознательно отбрасывает записи, которые не относятся к текущему месяцу, и кэширует уже сокращённый список. Backend endpoint для barber history в текущем контракте возвращает более полный набор. До remediation считать экран истории достоверным нельзя.
