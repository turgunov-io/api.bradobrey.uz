create table if not exists notifications (
  id uuid default gen_random_uuid() primary key,
  recipient_user_id uuid not null references users(id) on delete cascade,
  type text not null default 'suspicious_order',
  title text not null,
  body text not null,
  order_id uuid references queue_entries(id) on delete cascade,
  branch_id uuid references branches(id) on delete set null,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists notifications_recipient_type_order_idx on notifications (recipient_user_id, type, order_id);
create index if not exists notifications_recipient_created_idx on notifications (recipient_user_id, created_at desc);
