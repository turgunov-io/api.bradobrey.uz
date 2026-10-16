# Release report

## Git

- Commit: `0d8e154` (`fix: harden barber reassignment scope`).
- Push: успешно в `origin/main`; локальная ветка совпадает с `origin/main`.

## Production

- Public `https://api.bradobrey.uz/health` ответил HTTP 200, но endpoint показывает только liveness и не подтверждает новый commit.
- SSH к документированному `95.46.96.213` отклонён для `root`, `ubuntu` и `admin` (`Permission denied (publickey,password)`).
- PM2 status, server backup, overlay, restart, deployed commit hash и authenticated barber smoke выполнить не удалось.
- Production deployment: **BLOCKED** из-за отсутствия SSH-доступа. Dashboard и production data не затрагивались.

