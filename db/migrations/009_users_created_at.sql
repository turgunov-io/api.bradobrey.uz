-- 009_users_created_at — creation time of user accounts.
--
-- GET /api/platform/owners returns { id, login, created_at } per platform
-- owner; users had no creation timestamp. Existing rows get the time this
-- migration runs (their real creation time is unknown).
--
-- Additive. The API tolerates the column being absent (created_at: null),
-- so code and migration can be deployed in either order.
--
-- Rollback: db/migrations/down/009_users_created_at.down.sql

alter table users add column if not exists created_at timestamptz not null default now();
