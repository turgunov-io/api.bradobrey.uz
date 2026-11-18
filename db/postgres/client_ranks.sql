-- Client ranks (gamification) for `clients`.
-- Ranks: guest -> bronze -> silver -> gold

create table if not exists client_rank_settings (
  id integer primary key check (id = 1),
  bronze_min_visits integer not null default 2,
  silver_min_visits integer not null default 5,
  gold_min_visits integer not null default 10,
  updated_at timestamptz not null default now(),
  check (bronze_min_visits >= 1),
  check (silver_min_visits > bronze_min_visits),
  check (gold_min_visits > silver_min_visits)
);

-- Seed row of the DEFAULT company, with company_id set explicitly (MULTI_TENANCY:
-- no reliance on the tenant trigger's default-company fallback, so
-- app.tenant_strict = 'on' can be enabled). On a fresh database (before
-- db/migrations 001–003 add company_id) the legacy id = 1 row is seeded.
do $$
begin
  if to_regclass('public.companies') is not null
     and exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'client_rank_settings' and column_name = 'company_id') then
    insert into client_rank_settings (company_id)
    select c.id
      from companies c
     where c.is_default
       and not exists (select 1 from client_rank_settings s where s.company_id = c.id);
  else
    insert into client_rank_settings (id) values (1) on conflict (id) do nothing;
  end if;
end $$;

create or replace function public.set_client_rank_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_client_rank_settings_updated_at on client_rank_settings;
create trigger trg_client_rank_settings_updated_at
before update on client_rank_settings
for each row
execute function public.set_client_rank_settings_updated_at();

create or replace function public.on_client_rank_settings_changed()
returns trigger
language plpgsql
as $$
begin
  -- Only the clients of the company whose settings changed. to_jsonb keeps
  -- this valid on a fresh schema where company_id does not exist yet.
  perform public.recompute_company_client_ranks((to_jsonb(new) ->> 'company_id')::uuid);
  return new;
end;
$$;

drop trigger if exists trg_client_rank_settings_recompute_insert on client_rank_settings;
create trigger trg_client_rank_settings_recompute_insert
after insert on client_rank_settings
for each row
execute function public.on_client_rank_settings_changed();

drop trigger if exists trg_client_rank_settings_recompute_update on client_rank_settings;
create trigger trg_client_rank_settings_recompute_update
after update on client_rank_settings
for each row
execute function public.on_client_rank_settings_changed();

create or replace function public.compute_client_rank_by_visits(
  completed_visits integer,
  bronze_min_visits integer,
  silver_min_visits integer,
  gold_min_visits integer
)
returns text
language sql
immutable
as $$
select case
  when completed_visits >= gold_min_visits then 'gold'
  when completed_visits >= silver_min_visits then 'silver'
  when completed_visits >= bronze_min_visits then 'bronze'
  else 'guest'
end;
$$;

create or replace function public.client_rank_level(_rank text)
returns integer
language sql
immutable
as $$
select case
  when _rank = 'gold' then 3
  when _rank = 'silver' then 2
  when _rank = 'bronze' then 1
  else 0
end;
$$;

-- Company-aware (MULTI_TENANCY B2a); keep identical to
-- db/migrations/005_company_scoped_functions.sql (test/companySqlFunctions.test.js).
create or replace function public.recompute_company_client_ranks(p_company_id uuid)
returns void
language plpgsql
as $$
declare
  s record;
begin
  if p_company_id is null then
    -- Fresh schema before the tenant migrations: one global settings row.
    select bronze_min_visits, silver_min_visits, gold_min_visits
      into s
      from client_rank_settings
     where id = 1;
  else
    select bronze_min_visits, silver_min_visits, gold_min_visits
      into s
      from client_rank_settings
     where company_id = p_company_id;
  end if;

  if not found then
    s.bronze_min_visits := 2;
    s.silver_min_visits := 5;
    s.gold_min_visits := 10;
  end if;

  if p_company_id is null then
    update clients c
    set rank = public.compute_client_rank_by_visits(
          c.completed_visits, s.bronze_min_visits, s.silver_min_visits, s.gold_min_visits),
        rank_updated_at = now()
    where public.client_rank_level(public.compute_client_rank_by_visits(
            c.completed_visits, s.bronze_min_visits, s.silver_min_visits, s.gold_min_visits))
          > public.client_rank_level(c.rank);
  else
    update clients c
    set rank = public.compute_client_rank_by_visits(
          c.completed_visits, s.bronze_min_visits, s.silver_min_visits, s.gold_min_visits),
        rank_updated_at = now()
    where c.company_id = p_company_id
      and public.client_rank_level(public.compute_client_rank_by_visits(
            c.completed_visits, s.bronze_min_visits, s.silver_min_visits, s.gold_min_visits))
          > public.client_rank_level(c.rank);
  end if;
end;
$$;

create or replace function public.recompute_client_rank(_client_id uuid)
returns void
language plpgsql
as $$
declare
  s record;
  v_company_id uuid;
  v_completed integer;
  v_rank text;
  current_rank text;
  current_level integer;
  next_level integer;
begin
  if _client_id is null then
    return;
  end if;

  select completed_visits, rank, company_id
  into v_completed, current_rank, v_company_id
  from clients
  where id = _client_id;

  if not found then
    return;
  end if;

  -- Thresholds of the client's own company.
  select bronze_min_visits, silver_min_visits, gold_min_visits
  into s
  from client_rank_settings
  where company_id = v_company_id;

  if not found then
    s.bronze_min_visits := 2;
    s.silver_min_visits := 5;
    s.gold_min_visits := 10;
  end if;

  v_rank := public.compute_client_rank_by_visits(
    v_completed,
    s.bronze_min_visits,
    s.silver_min_visits,
    s.gold_min_visits
  );

  current_level := public.client_rank_level(current_rank);
  next_level := public.client_rank_level(v_rank);

  if next_level > current_level then
    update clients
    set rank = v_rank,
        rank_updated_at = now()
    where id = _client_id;
  end if;
end;
$$;

create or replace function public.recompute_all_client_ranks()
returns void
language plpgsql
as $$
declare
  company record;
begin
  if to_regclass('public.companies') is null or not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'client_rank_settings' and column_name = 'company_id'
  ) then
    perform public.recompute_company_client_ranks(null);
    return;
  end if;
  for company in select id from companies loop
    perform public.recompute_company_client_ranks(company.id);
  end loop;
end;
$$;

create or replace function public.sync_client_visits_on_queue_completed()
returns trigger
language plpgsql
as $$
declare
  client_id_to_touch uuid;
begin
  if (tg_op = 'INSERT') then
    if new.status = 'completed' and new.client_id is not null then
      client_id_to_touch := new.client_id;
    end if;
  elsif (tg_op = 'UPDATE') then
    if new.status = 'completed' and old.status is distinct from 'completed' and new.client_id is not null then
      client_id_to_touch := new.client_id;
    end if;
  end if;

  if client_id_to_touch is not null then
    update clients
    set completed_visits = completed_visits + 1
    where id = client_id_to_touch;

    perform public.recompute_client_rank(client_id_to_touch);
  end if;

  if (tg_op = 'DELETE') then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_queue_entries_client_visits_insert on queue_entries;
create trigger trg_queue_entries_client_visits_insert
after insert on queue_entries
for each row
execute function public.sync_client_visits_on_queue_completed();

drop trigger if exists trg_queue_entries_client_visits_update on queue_entries;
create trigger trg_queue_entries_client_visits_update
after update of status on queue_entries
for each row
execute function public.sync_client_visits_on_queue_completed();

-- Backfill: initialize completed_visits from historical completed entries (monotonic).
update clients c
set completed_visits = greatest(
  c.completed_visits,
  coalesce(q.cnt, 0)
)
from (
  select client_id, count(*)::int as cnt
  from queue_entries
  where status = 'completed' and client_id is not null
  group by client_id
) q
where c.id = q.client_id
  and c.completed_visits < q.cnt;

select public.recompute_all_client_ranks();
