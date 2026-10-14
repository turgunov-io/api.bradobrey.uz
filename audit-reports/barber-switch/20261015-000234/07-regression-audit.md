# Регрессионный аудит

- Auth helper и JWT validation не изменялись.
- Direct reassignment сохраняет documented response shape, candidate sorting, status reset, queue tail placement и Socket.IO события.
- Ownership стал строже и соответствует требованиям; manager transfer workflow остаётся отдельным endpoint и не изменён.
- Kiosk active-branch semantics reused for candidate selection; legacy schema fallback сохранён.
- Повторный запрос по конкурентно изменённой записи всё ещё требует PostgreSQL CAS/integration verification; локально это не подтверждено.

