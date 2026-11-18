-- Kiosk device registrations.
-- Backs src/services/kioskRegistration.js (POST /api/kiosk/register, which is
-- open but never overwrites a row that has a token, and POST /api/kiosk/socket-ticket).
-- A branch may have several kiosks: one row per (branch_id, device_name).
--   device_token_hash: SHA-256 of the token returned at registration; null for
--   kiosks registered before device tokens existed (legacy, name-only check).

create table if not exists kiosks (
  id uuid default gen_random_uuid() primary key,
  branch_id uuid not null references branches (id) on delete cascade,
  device_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Safety ALTERs so re-running on a partially-created table converges.
alter table kiosks add column if not exists branch_id uuid;
alter table kiosks add column if not exists device_name text;
alter table kiosks add column if not exists created_at timestamptz not null default now();
alter table kiosks add column if not exists updated_at timestamptz not null default now();
alter table kiosks add column if not exists device_token_hash text;

-- Several kiosks per branch (audit C5): the old one-per-branch index made each
-- registration silently disconnect the branch's other kiosk.
drop index if exists uq_kiosks_branch_id;
create unique index if not exists uq_kiosks_branch_device on kiosks (branch_id, device_name);

-- kioskAuth looks every kiosk request up by token hash (MULTI_TENANCY Phase 0).
-- Partial: legacy name-only kiosks have no hash.
create index if not exists idx_kiosks_device_token_hash
  on kiosks (device_token_hash)
  where device_token_hash is not null;

create or replace function public.set_kiosks_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_kiosks_updated_at on kiosks;
create trigger trg_kiosks_updated_at
before update on kiosks
for each row
execute function public.set_kiosks_updated_at();
