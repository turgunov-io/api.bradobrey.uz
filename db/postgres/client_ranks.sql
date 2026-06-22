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

insert into client_rank_settings (id)
values (1)
on conflict (id) do nothing;

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
  perform public.recompute_all_client_ranks();
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

create or replace function public.recompute_client_rank(_client_id uuid)
returns void
language plpgsql
as $$
declare
  s record;
  v_completed integer;
  v_rank text;
  current_rank text;
  current_level integer;
  next_level integer;
begin
  if _client_id is null then
    return;
  end if;

  select bronze_min_visits, silver_min_visits, gold_min_visits
  into s
  from client_rank_settings
  where id = 1;

  if not found then
    s.bronze_min_visits := 2;
    s.silver_min_visits := 5;
    s.gold_min_visits := 10;
  end if;

  select completed_visits, rank
  into v_completed, current_rank
  from clients
  where id = _client_id;

  if not found then
    return;
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
  s record;
begin
  select bronze_min_visits, silver_min_visits, gold_min_visits
  into s
  from client_rank_settings
  where id = 1;

  if not found then
    s.bronze_min_visits := 2;
    s.silver_min_visits := 5;
    s.gold_min_visits := 10;
  end if;

  update clients c
  set rank = public.compute_client_rank_by_visits(
        c.completed_visits,
        s.bronze_min_visits,
        s.silver_min_visits,
        s.gold_min_visits
      ),
      rank_updated_at = now()
  where public.client_rank_level(
        public.compute_client_rank_by_visits(
          c.completed_visits,
          s.bronze_min_visits,
          s.silver_min_visits,
          s.gold_min_visits
        )
      ) > public.client_rank_level(c.rank);
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
