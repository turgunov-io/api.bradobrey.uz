-- Rollback of 009_users_created_at.
-- Run manually in one transaction:  psql -v ON_ERROR_STOP=1 -1 -f <file>
-- The API tolerates the missing column (created_at: null).

alter table users drop column if exists created_at;

delete from schema_migrations where version = '009';
