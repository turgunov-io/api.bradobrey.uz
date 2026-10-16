create table if not exists branch_locations (
  id uuid default gen_random_uuid() primary key,
  branch_id uuid not null unique references branches(id) on delete cascade,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_meters integer not null default 1000 check (radius_meters between 1 and 50000),
  is_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists barber_login_location_events (
  id uuid default gen_random_uuid() primary key,
  client_event_id text,
  barber_id uuid not null references barbers(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade,
  latitude double precision,
  longitude double precision,
  branch_latitude double precision,
  branch_longitude double precision,
  distance_meters double precision,
  accuracy_meters double precision,
  measured_at timestamptz,
  status text not null check (status in ('inside_radius', 'outside_radius', 'rejected')),
  reason text,
  created_at timestamptz not null default now()
);

create unique index if not exists barber_login_location_events_client_idx
  on barber_login_location_events (barber_id, client_event_id)
  where client_event_id is not null;
create index if not exists barber_login_location_events_branch_created_idx
  on barber_login_location_events (branch_id, created_at desc);
create index if not exists barber_login_location_events_barber_created_idx
  on barber_login_location_events (barber_id, created_at desc);
