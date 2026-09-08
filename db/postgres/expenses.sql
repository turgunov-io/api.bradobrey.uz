create table if not exists expenses (
  id uuid default gen_random_uuid() primary key,
  branch_id uuid not null references branches(id) on delete restrict,
  category text not null,
  name text not null,
  amount numeric(12, 2) not null check (amount > 0),
  spent_at date not null default current_date,
  comment text,
  created_by uuid not null references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_expenses_branch_spent_at on expenses(branch_id, spent_at desc);
create index if not exists idx_expenses_category on expenses(category);
create index if not exists idx_expenses_created_by on expenses(created_by);
