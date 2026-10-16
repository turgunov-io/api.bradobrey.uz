create table if not exists employee_branch_access (
  employee_id uuid not null references users(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (employee_id, branch_id)
);

create index if not exists idx_employee_branch_access_branch
  on employee_branch_access (branch_id, is_active);

insert into employee_branch_access (employee_id, branch_id)
select u.id, u.branch_id
  from users u
 where u.branch_id is not null
on conflict (employee_id, branch_id) do nothing;

create table if not exists employee_active_branches (
  employee_id uuid primary key references users(id) on delete cascade,
  branch_id uuid not null references branches(id),
  is_on_shift boolean not null default false,
  session_id uuid,
  session_expires_at timestamptz,
  selected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table employee_active_branches
  add column if not exists session_id uuid,
  add column if not exists session_expires_at timestamptz;

create index if not exists idx_employee_active_branches_branch
  on employee_active_branches (branch_id, is_on_shift);

create index if not exists idx_employee_active_branches_session_expiry
  on employee_active_branches (session_expires_at)
  where session_id is not null;
