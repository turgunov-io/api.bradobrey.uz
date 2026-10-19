-- Certificate lifecycle for queue-backed bookings.
--
-- A certificate is reserved by an active queue entry and becomes used only
-- when that same queue entry changes to completed. The trigger keeps the
-- reservation/use transition in the same PostgreSQL transaction as the queue
-- row change, including cancellation, no-show and rollback deletes.

alter table certificates
  add column if not exists reserved_queue_entry_id uuid,
  add column if not exists reserved_at timestamptz,
  add column if not exists used_queue_entry_id uuid,
  add column if not exists used_at timestamptz;

create index if not exists idx_certificates_reserved_queue_entry
  on certificates (reserved_queue_entry_id)
  where reserved_queue_entry_id is not null;

create unique index if not exists idx_certificates_used_queue_entry_unique
  on certificates (used_queue_entry_id)
  where used_queue_entry_id is not null;

-- Preserve the reservation of active historical queue rows when this additive
-- migration is applied after certificates have already been issued. If bad
-- historical data points several active rows at one certificate, the oldest
-- row wins deterministically and the remaining rows stay blocked by the
-- certificate's single reservation slot.
do $$
begin
  if to_regclass('public.queue_entries') is not null then
    with candidates as (
      select distinct on (q.certificate_id)
        q.certificate_id,
        q.id as queue_entry_id,
        coalesce(q.created_at, now()) as reserved_at
      from queue_entries q
      join certificates c on c.id = q.certificate_id
      where q.certificate_id is not null
        and q.status in ('waiting', 'called', 'swapped', 'in_progress')
        and c.is_used = false
        and c.reserved_queue_entry_id is null
      order by q.certificate_id, q.created_at nulls first, q.id
    )
    update certificates c
       set reserved_queue_entry_id = candidates.queue_entry_id,
           reserved_at = candidates.reserved_at
      from candidates
     where c.id = candidates.certificate_id
       and c.reserved_queue_entry_id is null
       and c.is_used = false;
  end if;
end $$;

create or replace function public.sync_certificate_queue_lifecycle()
returns trigger
language plpgsql
as $$
declare
  claimed boolean;
begin
  if tg_op = 'DELETE' then
    if old.certificate_id is not null then
      update certificates
         set reserved_queue_entry_id = null,
             reserved_at = null
       where id = old.certificate_id
         and is_used = false
         and reserved_queue_entry_id = old.id;
    end if;
    return old;
  end if;

  -- A failed post-insert marketplace write deletes the queue row. This branch
  -- also makes that cleanup idempotent and releases the reservation in the
  -- same transaction as the delete.
  if tg_op = 'UPDATE'
     and old.certificate_id is distinct from new.certificate_id
     and old.certificate_id is not null then
    update certificates
       set reserved_queue_entry_id = null,
           reserved_at = null
     where id = old.certificate_id
       and is_used = false
       and reserved_queue_entry_id = old.id;
  end if;

  if new.certificate_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Let the existing idempotency unique constraint handle a retry without
    -- replacing the original successful reservation with a lifecycle error.
    if new.idempotency_key is not null
       and exists (
         select 1 from queue_entries
          where idempotency_key = new.idempotency_key
       ) then
      return new;
    end if;

    update certificates
       set reserved_queue_entry_id = new.id,
           reserved_at = coalesce(reserved_at, now())
     where id = new.certificate_id
       and is_used = false
       and reserved_queue_entry_id is null
       and (expires_at is null or expires_at > now());

    claimed := found;
    if not claimed then
      raise exception using
        errcode = 'P0001',
        message = 'CERTIFICATE_UNAVAILABLE';
    end if;
    return new;
  end if;

  -- A no-show may be explicitly reverted to waiting by the assigned barber.
  -- Reclaim the same certificate for that reopened queue entry, but do not
  -- release/reclaim it on ordinary active-status transitions.
  if new.status in ('waiting', 'called', 'swapped', 'in_progress') then
    if exists (
      select 1 from certificates
       where id = new.certificate_id
         and is_used = false
         and reserved_queue_entry_id = new.id
    ) then
      return new;
    end if;

    update certificates
       set reserved_queue_entry_id = new.id,
           reserved_at = coalesce(reserved_at, now())
     where id = new.certificate_id
       and is_used = false
       and reserved_queue_entry_id is null
       and (expires_at is null or expires_at > now());

    claimed := found;
    if not claimed then
      raise exception using
        errcode = 'P0001',
        message = 'CERTIFICATE_UNAVAILABLE';
    end if;
    return new;
  end if;

  if old.status is distinct from 'completed' and new.status = 'completed' then
    update certificates
       set is_used = true,
           used_queue_entry_id = new.id,
           used_at = coalesce(used_at, now()),
           reserved_queue_entry_id = null,
           reserved_at = null
     where id = new.certificate_id
       and is_used = false
       and reserved_queue_entry_id = new.id;

    claimed := found;
    if not claimed then
      raise exception using
        errcode = 'P0001',
        message = 'CERTIFICATE_RESERVATION_MISSING';
    end if;
    return new;
  end if;

  if old.status is distinct from new.status
     and new.status in ('cancelled', 'rejected', 'no_show', 'not_in_time') then
    update certificates
       set reserved_queue_entry_id = null,
           reserved_at = null
     where id = new.certificate_id
       and is_used = false
       and reserved_queue_entry_id = new.id;
  end if;

  return new;
end;
$$;

do $$
begin
  if to_regclass('public.queue_entries') is not null then
    execute 'drop trigger if exists queue_entries_certificate_lifecycle on public.queue_entries';
    execute 'create trigger queue_entries_certificate_lifecycle
      before insert or update of certificate_id, status or delete on public.queue_entries
      for each row execute function public.sync_certificate_queue_lifecycle()';
  end if;
end $$;
