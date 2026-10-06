-- Telegram user authorization for the marketplace.
-- Apply after marketplace_clients.sql. This migration is additive and idempotent.

alter table marketplace_clients alter column email drop not null;
alter table marketplace_clients add column if not exists display_name text;
alter table marketplace_clients add column if not exists language text not null default 'ru';
alter table marketplace_clients add column if not exists is_active boolean not null default true;
alter table marketplace_clients add column if not exists last_login_at timestamptz;

create unique index if not exists marketplace_clients_phone_uidx
  on marketplace_clients (phone)
  where phone is not null;

create table if not exists telegram_auth_challenges (
  id uuid primary key default gen_random_uuid(),
  challenge_hash text not null unique,
  phone text not null,
  phone_code_hash_encrypted text not null,
  telegram_session_encrypted text not null,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  two_factor_required boolean not null default false,
  display_name text,
  language text,
  expires_at timestamptz not null,
  locked_until timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table telegram_auth_challenges add column if not exists display_name text;
alter table telegram_auth_challenges add column if not exists language text;

create index if not exists telegram_auth_challenges_phone_idx
  on telegram_auth_challenges (phone, created_at desc);
create index if not exists telegram_auth_challenges_expiry_idx
  on telegram_auth_challenges (expires_at)
  where used_at is null;

create table if not exists telegram_auth_sessions (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  marketplace_client_id uuid not null references marketplace_clients(id) on delete cascade,
  telegram_user_id text,
  session_encrypted text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index if not exists telegram_auth_sessions_client_idx
  on telegram_auth_sessions (marketplace_client_id);

create or replace function touch_telegram_auth_session_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists telegram_auth_sessions_touch_updated_at on telegram_auth_sessions;
create trigger telegram_auth_sessions_touch_updated_at
before update on telegram_auth_sessions
for each row execute function touch_telegram_auth_session_updated_at();
