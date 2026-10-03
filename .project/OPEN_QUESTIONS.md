# Открытые вопросы владельцу

Вопросы не блокировали статический аудит, но нужны до реализации/production.

## OQ-01 — Комиссия маркетплейса

- Question: подтверждены ли ставки 5,5% для NEW и 2,5% для OWN и точное правило определения origin?
- Why it matters: backend не содержит найденной реализации origin/commission; это влияет на финансовый ledger и отчёты.
- Blocking level: BLOCKING для production финансов.
- Current assumption: реализовать строго по ТЗ после подтверждения бизнес-правил и примеров расчёта.
- Required owner decision: формула, момент фиксации origin, база комиссии, возвраты и rounding.

## OQ-02 — Payme/Click

- Question: онлайн-оплата входит в ближайший release или должна быть скрыта до отдельного этапа?
- Why it matters: способы рекламируются, но verified gateway/webhook flow не найден.
- Blocking level: BLOCKING, если способы видны production-клиентам.
- Current assumption: не рекламировать до полной реализации.
- Required owner decision: провайдеры, merchant contracts и rollout scope.

## OQ-03 — Runtime PostgreSQL

- Question: какая non-production DB предназначена для migration/integration/concurrency проверки?
- Why it matters: текущие credentials не позволили подключиться; применённость миграции не подтверждена.
- Blocking level: BLOCKING для окончательной приёмки.
- Current assumption: использовать отдельную staging DB с обезличенными данными.
- Required owner decision: предоставить безопасный staging access, не добавляя credentials в Git/документы.

## OQ-04 — Canonical source

- Question: публичный контракт должен использовать `MARKETPLACE`, сохраняя внутреннее legacy-сопоставление с `site`, или следует мигрировать queue source?
- Why it matters: от source зависят аналитика, origin и комиссия.
- Blocking level: IMPORTANT.
- Current assumption: API использует `MARKETPLACE`, persistence adapter явно переводит в legacy `site` до безопасной миграции.
- Required owner decision: подтвердить canonical contract.
