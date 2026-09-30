-- Durable queue transfer and status history. Existing orders remain valid.
alter table queue_entries drop constraint if exists queue_entries_status_check;
alter table queue_entries add constraint queue_entries_status_check
  check (status in ('waiting', 'called', 'swapped', 'transfer_pending', 'rejected', 'in_progress', 'completed', 'cancelled', 'no_show', 'not_in_time'));

create table if not exists queue_transfer_events (
  id uuid primary key default gen_random_uuid(),
  queue_entry_id uuid not null references queue_entries(id) on delete cascade,
  from_barber_id uuid references barbers(id) on delete set null,
  to_barber_id uuid references barbers(id) on delete set null,
  client_id uuid references clients(id) on delete set null,
  status text not null check (status in ('pending', 'accepted', 'rejected', 'returned', 'expired')),
  original_status text not null default 'waiting',
  requested_by uuid references barbers(id) on delete set null,
  responded_by uuid references barbers(id) on delete set null,
  requested_at timestamptz not null default now(),
  responded_at timestamptz,
  expires_at timestamptz not null,
  idempotency_key text,
  reason text
);
create unique index if not exists queue_transfer_events_idempotency_uq
  on queue_transfer_events (idempotency_key) where idempotency_key is not null;
create index if not exists queue_transfer_events_order_idx
  on queue_transfer_events (queue_entry_id, requested_at, id);
create index if not exists queue_transfer_events_recipient_pending_idx
  on queue_transfer_events (to_barber_id, status, expires_at);

create table if not exists queue_status_events (
  id bigserial primary key,
  queue_entry_id uuid not null references queue_entries(id) on delete cascade,
  from_status text,
  to_status text not null,
  barber_id uuid references barbers(id) on delete set null,
  occurred_at timestamptz not null default now()
);
create index if not exists queue_status_events_order_idx
  on queue_status_events (queue_entry_id, occurred_at, id);

create or replace function record_queue_status_event() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into queue_status_events(queue_entry_id, from_status, to_status, barber_id)
    values (new.id, null, new.status, new.barber_id);
  elsif old.status is distinct from new.status or old.barber_id is distinct from new.barber_id then
    insert into queue_status_events(queue_entry_id, from_status, to_status, barber_id)
    values (new.id, old.status, new.status, new.barber_id);
  end if;
  return new;
end;
$$;
drop trigger if exists queue_entries_status_event on queue_entries;
create trigger queue_entries_status_event after insert or update of status, barber_id
  on queue_entries for each row execute function record_queue_status_event();

-- Legacy orders get a baseline event without changing their current state.
insert into queue_status_events(queue_entry_id, from_status, to_status, barber_id, occurred_at)
select q.id, null, q.status, q.barber_id, coalesce(q.created_at, now())
from queue_entries q
where not exists (select 1 from queue_status_events e where e.queue_entry_id = q.id);
