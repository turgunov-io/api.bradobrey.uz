create table if not exists services (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  duration_minutes integer not null,
  base_price decimal(10,2),
  is_active boolean default true
);
