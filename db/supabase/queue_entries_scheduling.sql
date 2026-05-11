-- Scheduling fields for marketplace bookings (same-day time slots)
-- Safe to apply multiple times (idempotent).

create extension if not exists btree_gist;

alter table queue_entries
  add column if not exists scheduled_start_at timestamptz,
  add column if not exists scheduled_end_at timestamptz,
  add column if not exists idempotency_key text;

create index if not exists idx_queue_entries_scheduled_start
  on queue_entries (barber_id, scheduled_start_at);

create unique index if not exists idx_queue_entries_idempotency_key_unique
  on queue_entries (idempotency_key)
  where idempotency_key is not null;

alter table queue_entries
  drop constraint if exists queue_entries_scheduled_range_check;

alter table queue_entries
  add constraint queue_entries_scheduled_range_check
  check (
    scheduled_start_at is null
    or scheduled_end_at is null
    or scheduled_end_at > scheduled_start_at
  );

-- Prevent double booking of the same barber's time range for active (open) statuses only.
-- Cancelled/completed/no_show entries do not block new bookings.
alter table queue_entries
  drop constraint if exists queue_entries_scheduled_no_overlap;

alter table queue_entries
  add constraint queue_entries_scheduled_no_overlap
  exclude using gist (
    barber_id with =,
    tstzrange(scheduled_start_at, scheduled_end_at, '[)') with &&
  )
  where (
    scheduled_start_at is not null
    and scheduled_end_at is not null
    and status in ('waiting', 'called', 'swapped', 'in_progress')
  );
