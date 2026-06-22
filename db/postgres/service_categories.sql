create table if not exists service_categories (
  id uuid default gen_random_uuid() primary key,
  branch_id uuid,
  marketplace_barbershop_id uuid,
  name text not null,
  sort_order integer default 0,
  is_active boolean default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists service_categories
  add column if not exists branch_id uuid,
  add column if not exists marketplace_barbershop_id uuid,
  add column if not exists name text,
  add column if not exists sort_order integer default 0,
  add column if not exists is_active boolean default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_service_categories_branch
  on service_categories (branch_id, is_active, sort_order, name);

create index if not exists idx_service_categories_marketplace
  on service_categories (marketplace_barbershop_id, is_active, sort_order, name);

