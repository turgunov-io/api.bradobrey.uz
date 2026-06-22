create table if not exists clients (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  phone text unique not null,
  first_visit_date date default current_date,
  rank text not null default 'guest',
  completed_visits integer not null default 0,
  rank_updated_at timestamptz
);

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'clients' and column_name = 'rank'
  ) then
    alter table clients add column rank text not null default 'guest';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'clients' and column_name = 'completed_visits'
  ) then
    alter table clients add column completed_visits integer not null default 0;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'clients' and column_name = 'rank_updated_at'
  ) then
    alter table clients add column rank_updated_at timestamptz;
  end if;
end $$;

alter table if exists clients
  drop constraint if exists clients_rank_check;

alter table if exists clients
  add constraint clients_rank_check
  check (rank in ('guest', 'bronze', 'silver', 'gold'));
