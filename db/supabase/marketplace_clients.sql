create table if not exists marketplace_clients (
  id uuid default gen_random_uuid() primary key,
  email text unique not null,
  password_hash text,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

