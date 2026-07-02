create table if not exists warehouse_positions (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  sku text unique,
  unit text not null default 'pcs',
  category text,
  min_quantity numeric(12,3) not null default 0 check (min_quantity >= 0),
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table warehouse_positions
  add column if not exists sku text,
  add column if not exists unit text not null default 'pcs',
  add column if not exists category text,
  add column if not exists min_quantity numeric(12,3) not null default 0,
  add column if not exists is_active boolean not null default true,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists idx_warehouse_positions_sku
  on warehouse_positions (sku)
  where sku is not null;

create index if not exists idx_warehouse_positions_active
  on warehouse_positions (is_active, name);

create table if not exists warehouse_templates (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  description text,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table warehouse_templates
  add column if not exists description text,
  add column if not exists is_active boolean not null default true,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_warehouse_templates_active
  on warehouse_templates (is_active, name);

create table if not exists warehouse_template_items (
  id uuid default gen_random_uuid() primary key,
  template_id uuid not null references warehouse_templates(id) on delete cascade,
  position_id uuid references warehouse_positions(id) on delete set null,
  name text,
  sku text,
  unit text not null default 'pcs',
  quantity numeric(12,3) not null default 1 check (quantity >= 0),
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table warehouse_template_items
  add column if not exists position_id uuid references warehouse_positions(id) on delete set null,
  add column if not exists name text,
  add column if not exists sku text,
  add column if not exists unit text not null default 'pcs',
  add column if not exists quantity numeric(12,3) not null default 1,
  add column if not exists sort_order integer not null default 0,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

create index if not exists idx_warehouse_template_items_template
  on warehouse_template_items (template_id, sort_order);

create table if not exists warehouse_stocks (
  id uuid default gen_random_uuid() primary key,
  branch_id uuid references branches(id) on delete cascade,
  position_id uuid not null references warehouse_positions(id) on delete cascade,
  quantity numeric(12,3) not null default 0 check (quantity >= 0),
  reserved_quantity numeric(12,3) not null default 0 check (reserved_quantity >= 0),
  updated_at timestamptz not null default now(),
  unique (branch_id, position_id)
);

alter table warehouse_stocks
  add column if not exists branch_id uuid references branches(id) on delete cascade,
  add column if not exists reserved_quantity numeric(12,3) not null default 0,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_warehouse_stocks_position
  on warehouse_stocks (position_id);

create table if not exists warehouse_purchases (
  id uuid default gen_random_uuid() primary key,
  branch_id uuid references branches(id) on delete set null,
  supplier_name text,
  purchased_at timestamptz not null default now(),
  status text not null default 'received' check (status in ('draft', 'ordered', 'received', 'cancelled')),
  total_amount numeric(12,2) not null default 0 check (total_amount >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table warehouse_purchases
  add column if not exists branch_id uuid references branches(id) on delete set null,
  add column if not exists supplier_name text,
  add column if not exists purchased_at timestamptz not null default now(),
  add column if not exists status text not null default 'received',
  add column if not exists total_amount numeric(12,2) not null default 0,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_warehouse_purchases_branch_time
  on warehouse_purchases (branch_id, purchased_at desc);

create index if not exists idx_warehouse_purchases_status_time
  on warehouse_purchases (status, purchased_at desc);

create table if not exists warehouse_purchase_items (
  id uuid default gen_random_uuid() primary key,
  purchase_id uuid not null references warehouse_purchases(id) on delete cascade,
  position_id uuid references warehouse_positions(id) on delete set null,
  name text,
  sku text,
  unit text not null default 'pcs',
  quantity numeric(12,3) not null default 1 check (quantity >= 0),
  unit_cost numeric(12,2) not null default 0 check (unit_cost >= 0),
  total_amount numeric(12,2) not null default 0 check (total_amount >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table warehouse_purchase_items
  add column if not exists position_id uuid references warehouse_positions(id) on delete set null,
  add column if not exists name text,
  add column if not exists sku text,
  add column if not exists unit text not null default 'pcs',
  add column if not exists quantity numeric(12,3) not null default 1,
  add column if not exists unit_cost numeric(12,2) not null default 0,
  add column if not exists total_amount numeric(12,2) not null default 0,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

create index if not exists idx_warehouse_purchase_items_purchase
  on warehouse_purchase_items (purchase_id);
