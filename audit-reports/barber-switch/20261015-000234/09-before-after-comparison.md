# До/после

| Проверка | До исправления | После исправления |
|---|---|---|
| Смена барбера | Historical unreachable-code fixed earlier; current path могла не найти temporary-branch barber и позволяла same-branch чужую запись | Owner-scoped path; temporary-branch candidates merged with fresh presence |
| Первопричина | `barbers.branch_id` использовался как единственный branch source; branch claim bypassed owner filter | Active branch source aligned with kiosk; owner filter applied to read/update |
| Unit/contract tests | 106/106 pass; no owner/temporary-branch regression | 108/108 pass, including 2 new regressions |
| Integration tests | 1 skipped | 1 skipped; PostgreSQL unavailable |
| Flutter analysis | Not applicable: sources absent | Not applicable: sources absent |
| Security | Ownership bypass and candidate scope gap | Ownership fixed; dependency and runtime DB risks remain documented |

