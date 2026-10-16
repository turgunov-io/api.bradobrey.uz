# Security-аудит

## Исправлено

- BS-001: branch claim больше не является заменой ownership; чужая queue entry не выбирается и не обновляется.
- BS-002: candidate list ограничена текущим branch, operational role, active/non-archived состоянием и свежим on-shift presence.

## Открытые риски

- `npm audit` показывает существующие dependency vulnerabilities; forced upgrade не выполнялся, чтобы не менять unrelated runtime без отдельного плана.
- Live pentest, production DB role verification и authenticated production smoke не выполнялись.
- Полная атомарность direct reassignment при конкуренции не доказана runtime-тестом и остаётся отдельным риском BS-003.

