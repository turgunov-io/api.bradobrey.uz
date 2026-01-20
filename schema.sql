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
  specialization text
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
  status text check (status in ('waiting', 'called', 'swapped', 'rejected', 'in_progress', 'completed', 'cancelled', 'no_show')) default 'waiting',
  created_at timestamp default now(),
  started_at timestamp,
  finished_at timestamp,
  swapped_flag boolean default false
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

-- Helpful indexes for queue lookups
create index if not exists idx_queue_entries_barber_status on queue_entries (barber_id, status, created_at);
create index if not exists idx_queue_entries_branch_status on queue_entries (branch_id, status, created_at);
