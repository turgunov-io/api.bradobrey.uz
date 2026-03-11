create table if not exists users (
  id uuid default gen_random_uuid() primary key,
  login text unique not null,
  password_hash text not null,
  role text check (role in ('admin_network', 'admin_branch', 'barber')),
  branch_id uuid references branches(id)
);
