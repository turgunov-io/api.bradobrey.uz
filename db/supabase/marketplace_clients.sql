create table if not exists marketplace_clients (
  id uuid default gen_random_uuid() primary key,
  email text unique not null,
  password_hash text,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

-- If the table already exists, CREATE TABLE IF NOT EXISTS won't add new columns.
-- Keep this file idempotent for existing databases.
alter table marketplace_clients
  add column if not exists password_hash text;
