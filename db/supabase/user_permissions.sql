alter table if exists users drop constraint if exists users_role_check;

alter table if exists users
  add constraint users_role_check
  check (role in ('admin_network', 'admin_branch', 'admin', 'manager', 'barber', 'super-barber', 'super-manager'));

create table if not exists user_permissions (
  user_id uuid not null references users(id) on delete cascade,
  permission text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, permission)
);

create index if not exists idx_user_permissions_user_id on user_permissions (user_id);
