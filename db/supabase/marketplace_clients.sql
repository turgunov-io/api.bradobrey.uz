create table if not exists marketplace_clients (
  id uuid default gen_random_uuid() primary key,
  email text unique not null,
  password_hash text,
  phone text,
  photo_url text,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

-- If the table already exists, CREATE TABLE IF NOT EXISTS won't add new columns.
-- Keep this file idempotent for existing databases.
alter table marketplace_clients
  add column if not exists password_hash text;

alter table marketplace_clients
  add column if not exists phone text;

alter table marketplace_clients
  add column if not exists photo_url text;

create index if not exists idx_marketplace_clients_phone on marketplace_clients (phone);
