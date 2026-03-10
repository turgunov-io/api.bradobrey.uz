-- Schema for barbershop live queue (Supabase/PostgreSQL)
-- Enable UUID generation
create extension if not exists "pgcrypto";

create table if not exists branches (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  address text,
  city text,
  work_hours jsonb,
  timezone text,
  is_active boolean default true
);

create table if not exists barbers (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  photo_url text,
  branch_id uuid references branches(id),
  is_authorized boolean default false,
  is_on_shift boolean default false,
  specialization text,
  phone text
);

create table if not exists services (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  duration_minutes integer not null,
  base_price decimal(10,2),
  is_active boolean default true
);

create table if not exists clients (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  phone text unique not null,
  first_visit_date date default current_date
);

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
  payment_method text check (payment_method in ('cash', 'card', 'certificate'))
);

create table if not exists payments (
  id uuid default gen_random_uuid() primary key,
  queue_entry_id uuid references queue_entries(id),
  amount decimal(10,2) not null,
  method text check (method in ('cash', 'card', 'certificate')),
  created_at timestamp default now()
);

create table if not exists users (
  id uuid default gen_random_uuid() primary key,
  login text unique not null,
  password_hash text not null,
  role text check (role in ('admin_network', 'admin_branch', 'barber')),
  branch_id uuid references branches(id)
);

create table if not exists media_assets (
  id uuid default gen_random_uuid() primary key,
  type text check (type in ('kids', 'ads', 'music', 'video')) not null,
  title text,
  url text not null,
  mime_type text,
  duration_seconds integer,
  is_active boolean default true,
  barber_id uuid references barbers(id),
  created_at timestamp default now(),
  updated_at timestamp default now()
);

-- Helpful indexes for queue lookups
create index if not exists idx_queue_entries_barber_status on queue_entries (barber_id, status, created_at);
create index if not exists idx_queue_entries_branch_status on queue_entries (branch_id, status, created_at);
create index if not exists idx_media_assets_type_active on media_assets (type, is_active, created_at);

-- Safety migrations for existing databases (no-op if columns already exist)
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

  -- Ensure status enum includes new value 'not_in_time'
  begin
    execute 'alter table queue_entries drop constraint if exists queue_entries_status_check';
  exception when undefined_object then null;
  end;
  alter table queue_entries
    add constraint queue_entries_status_check
    check (status in ('waiting', 'called', 'swapped', 'rejected', 'in_progress', 'completed', 'cancelled', 'no_show', 'not_in_time'));

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'barbers' and column_name = 'phone'
  ) then
    alter table barbers add column phone text;
  end if;

  if not exists (
    select 1
    from information_schema.tables
    where table_name = 'media_assets'
  ) then
    create table media_assets (
      id uuid default gen_random_uuid() primary key,
      type text check (type in ('kids', 'ads', 'music', 'video')) not null,
      title text,
      url text not null,
      mime_type text,
      duration_seconds integer,
      is_active boolean default true,
      barber_id uuid references barbers(id),
      created_at timestamp default now(),
      updated_at timestamp default now()
    );
    create index idx_media_assets_type_active on media_assets (type, is_active, created_at);
    create index idx_media_assets_barber on media_assets (barber_id, type, is_active, created_at);
  else
    -- Ensure type constraint includes video
    begin
      execute 'alter table media_assets drop constraint if exists media_assets_type_check';
    exception when undefined_object then null;
    end;
    alter table media_assets add constraint media_assets_type_check check (type in ('kids', 'ads', 'music', 'video'));

    if not exists (
      select 1
      from information_schema.columns
      where table_name = 'media_assets' and column_name = 'barber_id'
    ) then
      alter table media_assets add column barber_id uuid references barbers(id);
    end if;

    if not exists (
      select 1 from pg_indexes where tablename = 'media_assets' and indexname = 'idx_media_assets_barber'
    ) then
      create index idx_media_assets_barber on media_assets (barber_id, type, is_active, created_at);
    end if;
  end if;
end $$;
