# После-аудит

## Исправления

- `reassignQueue` теперь всегда ограничивает чтение и update по `barber_id = auth.barberId`, включая branch-scoped JWT.
- `getBranchBarberAvailability` объединяет постоянных барберов и сотрудников из `employee_active_branches`, проверяет свежий 90-секундный presence и возвращает текущий branch id.
- При отсутствии additive active-branch таблицы сохранён legacy fallback; ошибки существующей таблицы не скрываются.

## Повторная проверка

- Contract-тесты ownership и temporary-branch candidate добавлены и проходят.
- Секреты/токены/PII в код и отчёты не добавлялись.
- PostgreSQL runtime и authenticated HTTP smoke остаются непроверенными из-за недоступной локальной БД и отсутствия тестовой сессии.

