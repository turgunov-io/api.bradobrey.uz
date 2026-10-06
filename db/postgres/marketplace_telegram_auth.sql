-- Telegram Bot phone verification for the marketplace.
-- Apply after marketplace_clients.sql. This migration is additive and idempotent.

alter table marketplace_clients alter column email drop not null;
alter table marketplace_clients add column if not exists display_name text;
alter table marketplace_clients add column if not exists language text not null default 'ru';
alter table marketplace_clients add column if not exists is_active boolean not null default true;
alter table marketplace_clients add column if not exists last_login_at timestamptz;
alter table marketplace_clients add column if not exists telegram_user_id text;
alter table marketplace_clients add column if not exists telegram_chat_id text;

create unique index if not exists marketplace_clients_phone_uidx
  on marketplace_clients (phone)
  where phone is not null;
create unique index if not exists marketplace_clients_telegram_user_uidx
  on marketplace_clients (telegram_user_id)
  where telegram_user_id is not null;
create unique index if not exists marketplace_clients_telegram_chat_uidx
  on marketplace_clients (telegram_chat_id)
  where telegram_chat_id is not null;

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
alter table telegram_auth_challenges alter column phone_code_hash_encrypted drop not null;
alter table telegram_auth_challenges alter column telegram_session_encrypted drop not null;
alter table telegram_auth_challenges add column if not exists gateway_request_id text;
alter table telegram_auth_challenges add column if not exists status text;
alter table telegram_auth_challenges add column if not exists delivery_status text;
alter table telegram_auth_challenges add column if not exists verification_status text;
alter table telegram_auth_challenges add column if not exists updated_at timestamptz;
alter table telegram_auth_challenges add column if not exists link_token_hash text;
alter table telegram_auth_challenges add column if not exists otp_hash text;
alter table telegram_auth_challenges add column if not exists telegram_user_id text;
alter table telegram_auth_challenges add column if not exists telegram_chat_id text;

-- Rows created by the former MTProto implementation are intentionally made
-- terminal without deleting their audit data.
update telegram_auth_challenges set status = coalesce(status, 'failed');
update telegram_auth_challenges set updated_at = coalesce(updated_at, created_at, now());
alter table telegram_auth_challenges alter column status set default 'failed';
alter table telegram_auth_challenges alter column status set not null;
alter table telegram_auth_challenges alter column updated_at set default now();
alter table telegram_auth_challenges alter column updated_at set not null;

create unique index if not exists telegram_auth_challenges_gateway_request_uidx
  on telegram_auth_challenges (gateway_request_id)
  where gateway_request_id is not null;
create unique index if not exists telegram_auth_challenges_link_token_uidx
  on telegram_auth_challenges (link_token_hash)
  where link_token_hash is not null;

create index if not exists telegram_auth_challenges_phone_idx
  on telegram_auth_challenges (phone, created_at desc);
create index if not exists telegram_auth_challenges_expiry_idx
  on telegram_auth_challenges (expires_at)
  where used_at is null;
create index if not exists telegram_auth_challenges_status_phone_idx
  on telegram_auth_challenges (phone, status, created_at desc);
create index if not exists telegram_auth_challenges_telegram_idx
  on telegram_auth_challenges (telegram_user_id, telegram_chat_id, status);

-- The former MTProto session table is intentionally not created for new
-- deployments. Existing installations may retain it until a separately
-- approved data-retention cleanup; the Bot flow never reads or writes it.
