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

alter table marketplace_clients
  add column if not exists is_active boolean;

alter table marketplace_clients
  add column if not exists last_login_at timestamptz;

alter table marketplace_clients
  add column if not exists created_at timestamptz;

-- Backfill and enforce defaults for older databases that may have missing/null values.
update marketplace_clients set is_active = true where is_active is null;
update marketplace_clients set created_at = now() where created_at is null;

alter table marketplace_clients
  alter column is_active set default true;

alter table marketplace_clients
  alter column is_active set not null;

alter table marketplace_clients
  alter column created_at set default now();

alter table marketplace_clients
  alter column created_at set not null;

create index if not exists idx_marketplace_clients_phone on marketplace_clients (phone);
