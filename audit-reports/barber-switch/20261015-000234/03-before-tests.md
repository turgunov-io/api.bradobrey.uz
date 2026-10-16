# До-тесты

Команды и фактические результаты:

- `npm test` — 106 passed, 0 failed.
- `npm run test:integration` — 0 passed, 0 failed, 1 skipped (`MARKETPLACE_INTEGRATION`/PostgreSQL не включён).
- `node --check` для 130 JS-файлов в `src`, `scripts`, `test` — 130 passed, 0 failed.
- `git diff --check` — до изменений рабочее дерево чистое.

Ограничение: существующий `test/queueTransfers.test.js` проверял наличие фрагментов исходника, но не выполнял HTTP/DB reassignment. Реальная PostgreSQL интеграция до изменений не подтверждена.

