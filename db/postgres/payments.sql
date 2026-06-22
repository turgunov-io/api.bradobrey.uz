create table if not exists payments (
  id uuid default gen_random_uuid() primary key,
  queue_entry_id uuid references queue_entries(id),
  amount decimal(10,2) not null,
  method text check (method in ('cash', 'card', 'certificate')),
  created_at timestamp default now()
);
