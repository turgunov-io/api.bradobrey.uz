create table if not exists services (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  duration_minutes integer not null,
  base_price decimal(10,2),
  category text,
  sort_order integer,
  image text,
  branch_id uuid,
  marketplace_barbershop_id uuid,
  is_active boolean default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists services
  add column if not exists category text,
  add column if not exists sort_order integer,
  add column if not exists image text,
  add column if not exists branch_id uuid,
  add column if not exists marketplace_barbershop_id uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_services_category on services (category);
create index if not exists idx_services_branch on services (branch_id, is_active);
create index if not exists idx_services_marketplace on services (marketplace_barbershop_id, is_active);
