create table if not exists users (
  id uuid default gen_random_uuid() primary key,
  login text unique not null,
  password_hash text not null,
  role text check (role in ('admin_network', 'admin_branch', 'admin', 'manager', 'merchant', 'barber', 'super-barber', 'super-manager')),
  branch_id uuid references branches(id),
  marketplace_barbershop_id uuid
);

alter table if exists users
  add column if not exists marketplace_barbershop_id uuid;

create index if not exists idx_users_marketplace_barbershop
  on users (marketplace_barbershop_id, role);
