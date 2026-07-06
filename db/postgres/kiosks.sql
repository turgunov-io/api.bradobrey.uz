-- Kiosk device registrations.
-- Backs src/models/kiosk.js register() and POST /api/kiosk/register.
-- The endpoint deletes any existing row for a branch and inserts a fresh one,
-- so a branch has at most one registered kiosk device (enforced by the unique
-- constraint on branch_id).
--   Columns mirror the fields read/written by the model: branch_id, device_name.

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

-- One kiosk device per branch (matches the delete-then-insert in register()).
create unique index if not exists uq_kiosks_branch_id on kiosks (branch_id);

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
