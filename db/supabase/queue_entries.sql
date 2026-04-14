create table if not exists queue_entries (
  id uuid default gen_random_uuid() primary key,
  client_id uuid references clients(id),
  branch_id uuid references branches(id),
  barber_id uuid references barbers(id),
  service_id uuid references services(id),
  service_ids uuid[],
  source text check (source in ('point', 'site', 'admin')),
  status text check (status in ('waiting', 'called', 'swapped', 'rejected', 'in_progress', 'completed', 'cancelled', 'no_show', 'not_in_time')) default 'waiting',
  created_at timestamp default now(),
  started_at timestamp,
  finished_at timestamp,
  swapped_flag boolean default false,
  payment_method text check (payment_method in ('cash', 'card', 'certificate')),
  certificate_id uuid
);

create index if not exists idx_queue_entries_barber_status on queue_entries (barber_id, status, created_at);
create index if not exists idx_queue_entries_branch_status on queue_entries (branch_id, status, created_at);

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'queue_entries' and column_name = 'service_ids'
  ) then
    alter table queue_entries add column service_ids uuid[];
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'queue_entries' and column_name = 'payment_method'
  ) then
    alter table queue_entries add column payment_method text check (payment_method in ('cash', 'card', 'certificate'));
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'queue_entries' and column_name = 'certificate_id'
  ) then
    alter table queue_entries add column certificate_id uuid;
  end if;

  begin
    execute 'alter table queue_entries drop constraint if exists queue_entries_status_check';
  exception when undefined_object then null;
  end;

  alter table queue_entries
    add constraint queue_entries_status_check
    check (status in ('waiting', 'called', 'swapped', 'rejected', 'in_progress', 'completed', 'cancelled', 'no_show', 'not_in_time'));
end $$;

create index if not exists idx_queue_entries_certificate_id on queue_entries (certificate_id);
