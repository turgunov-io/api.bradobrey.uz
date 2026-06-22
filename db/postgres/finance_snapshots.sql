create table if not exists finance_snapshots (
  branch_id uuid references branches(id) on delete cascade,
  period text not null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamp default now(),
  primary key (branch_id, period),
  constraint finance_snapshots_period_check check (period ~ '^\d{4}-\d{2}$')
);

create index if not exists idx_finance_snapshots_period on finance_snapshots (period);
