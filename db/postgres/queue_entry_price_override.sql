alter table queue_entries
  add column if not exists price_override numeric(12,2),
  add column if not exists price_override_reason text,
  add column if not exists updated_at timestamptz;

update queue_entries
set updated_at = coalesce(finished_at, created_at, now())
where updated_at is null;

alter table queue_entries
  alter column updated_at set default now(),
  alter column updated_at set not null;

alter table queue_entries
  drop constraint if exists queue_entries_price_override_check;

alter table queue_entries
  add constraint queue_entries_price_override_check
  check (price_override is null or price_override >= 0);
