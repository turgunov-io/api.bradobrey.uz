create table if not exists services (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  duration_minutes integer not null,
  base_price decimal(10,2),
  category text,
  is_active boolean default true
);

alter table if exists services
  add column if not exists category text;

create index if not exists idx_services_category on services (category);
