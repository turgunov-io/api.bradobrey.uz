# Root cause до исправления

Подтверждённая первопричина текущего дефекта — несовместимость новой модели временного активного филиала с логикой выбора кандидатов смены барбера: `reassignQueue` проверял только постоянный `barbers.branch_id`, тогда как kiosk и branch-switch сохраняют текущий филиал в `employee_active_branches`.

Отдельный подтверждённый security-дефект — ownership проверялся только для legacy JWT без `branchId`; токен с branch claim позволял сотруднику того же филиала менять чужую очередь.

Исторический дефект, устранённый в commit `9951d89`, также подтверждён через parent commit: `reassignQueue` начинался с `return queueTransfers.request(req, res)`, поэтому документированный immediate endpoint никогда не доходил до direct reassignment.

Runtime PostgreSQL/HTTP reproduction до исправления невозможен: локальный PostgreSQL не доступен/интеграционный тест skipped. Поэтому утверждение ограничено статической трассировкой и contract-тестами; production smoke не заявляется.

