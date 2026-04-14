-- Cashback (loyalty) system
-- Wallet is attached to `clients` (phone-based identity).

create table if not exists cashback_wallets (
  client_id uuid primary key references clients(id) on delete cascade,
  balance numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists cashback_transactions (
  id uuid default gen_random_uuid() primary key,
  client_id uuid not null references clients(id) on delete cascade,
  queue_entry_id uuid references queue_entries(id) on delete set null,
  kind text not null check (kind in ('earn', 'spend', 'adjust')),
  amount numeric(12,2) not null,
  meta jsonb,
  created_at timestamptz not null default now(),
  check (amount > 0)
);

-- Prevent duplicate earn/spend for the same order
create unique index if not exists idx_cashback_transactions_queue_kind
  on cashback_transactions (queue_entry_id, kind)
  where queue_entry_id is not null;

create index if not exists idx_cashback_transactions_client_created_at
  on cashback_transactions (client_id, created_at desc);

create index if not exists idx_cashback_transactions_queue_entry_id
  on cashback_transactions (queue_entry_id);

