-- Reversible marketplace status points and rank configuration consistency.
-- Apply after marketplace_tz_compliance.sql.

do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'marketplace_clients_status_points_nonnegative'
                    and conrelid = 'marketplace_clients'::regclass) then
    alter table marketplace_clients
      add constraint marketplace_clients_status_points_nonnegative
      check (status_points >= 0) not valid;
  end if;
end $$;

alter table status_point_transactions drop constraint if exists status_point_transactions_kind_check;
alter table status_point_transactions add constraint status_point_transactions_kind_check
  check (kind in ('EARN', 'PENALTY', 'ADJUSTMENT', 'REVERSAL'));

create unique index if not exists status_point_queue_reversal_uidx
  on status_point_transactions (queue_entry_id, kind)
  where queue_entry_id is not null;

-- Store cancellation and no-show penalties per rank. Existing global values
-- seed every current rank so deployments keep their configured behavior.
insert into platform_settings (key, value, description)
select 'loyalty_levels', coalesce((select value from platform_settings where key = 'loyalty_levels' limit 1), '{"NONE":{"min_points":0,"cashback_percent":0},"BRONZE":{"min_points":100,"cashback_percent":1},"SILVER":{"min_points":300,"cashback_percent":2},"GOLD":{"min_points":1500,"cashback_percent":2.5}}'::jsonb), 'Marketplace status point levels'
on conflict (key) do nothing;

update platform_settings setting
   set value = coalesce((select jsonb_object_agg(level.name, level.value || jsonb_build_object(
       'cancel_penalty_points', greatest(0, coalesce((level.value ->> 'cancel_penalty_points')::integer, abs((points.value ->> 'late_cancel_penalty')::integer), 10)),
       'no_show_penalty_points', greatest(0, coalesce((level.value ->> 'no_show_penalty_points')::integer, abs((points.value ->> 'no_show_penalty')::integer), 30))
   )) from jsonb_each(setting.value) as level(name, value)
      cross join lateral (select coalesce((select value from platform_settings where key = 'status_points'), '{}'::jsonb) as value) points), setting.value)
 where setting.key = 'loyalty_levels'
   and exists (select 1 from jsonb_each(setting.value) level(name, value)
                where not (level.value ? 'cancel_penalty_points') or not (level.value ? 'no_show_penalty_points'));

-- Reverse historical awards for already-cancelled completed queue entries.
-- The unique queue/kind index makes this backfill safe to retry.
do $$
declare
  item record;
begin
  for item in
    select earn.marketplace_client_id, earn.queue_entry_id, earn.amount, q.status
      from status_point_transactions earn
      join queue_entries q on q.id = earn.queue_entry_id
     where earn.kind = 'EARN'
       and q.status in ('cancelled', 'rejected', 'no_show', 'not_in_time')
       and not exists (select 1 from status_point_transactions reversal
                        where reversal.queue_entry_id = earn.queue_entry_id
                          and reversal.kind = 'REVERSAL')
     order by q.finished_at nulls last, q.id
  loop
    perform 1 from marketplace_clients where id = item.marketplace_client_id for update;
    insert into status_point_transactions
      (marketplace_client_id, queue_entry_id, kind, amount, reason, metadata)
    values (item.marketplace_client_id, item.queue_entry_id, 'REVERSAL', -item.amount,
            'COMPLETED_SERVICE_CANCELLED_BACKFILL',
            jsonb_build_object('reverses', 'EARN', 'final_status', item.status, 'backfill', true))
    on conflict (queue_entry_id, kind) where queue_entry_id is not null do nothing;
    if found then
      update marketplace_clients
         set status_points = greatest(0, status_points - item.amount)
       where id = item.marketplace_client_id;
    end if;
  end loop;
end $$;

-- Existing completed orders that predate the original point trigger receive
-- the configured completion award once, with the same per-day positive cap.
do $$
declare
  item record;
  award integer;
  daily_limit integer;
  awarded_today integer;
begin
  for item in
    select q.id as queue_entry_id, mc.id as marketplace_client_id,
           coalesce(q.finished_at, q.created_at) as event_at,
           (coalesce(q.finished_at, q.created_at) at time zone 'Asia/Tashkent')::date as service_day
      from queue_entries q
      join clients c on c.id = q.client_id
      join marketplace_clients mc
        on regexp_replace(coalesce(mc.phone, ''), '[^0-9]', '', 'g') =
           regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')
       and regexp_replace(coalesce(mc.phone, ''), '[^0-9]', '', 'g') <> ''
     where q.status = 'completed' and q.source = 'site'
       and not exists (select 1 from status_point_transactions s
                        where s.queue_entry_id = q.id and s.kind = 'EARN')
     order by event_at, q.id
  loop
    perform 1 from marketplace_clients where id = item.marketplace_client_id for update;
    select greatest(0, coalesce((value ->> 'completed_service_points')::integer, 10)),
           greatest(0, coalesce((value ->> 'daily_positive_limit')::integer, 20))
      into award, daily_limit from platform_settings where key = 'status_points';
    award := coalesce(award, 10);
    daily_limit := coalesce(daily_limit, 20);
    select coalesce(sum(amount), 0)::integer into awarded_today
      from status_point_transactions
     where marketplace_client_id = item.marketplace_client_id and amount > 0
       and (created_at at time zone 'Asia/Tashkent')::date = item.service_day;
    if award > 0 and awarded_today + award <= daily_limit then
      insert into status_point_transactions
        (marketplace_client_id, queue_entry_id, kind, amount, reason, metadata, created_at)
      values (item.marketplace_client_id, item.queue_entry_id, 'EARN', award,
              'COMPLETED_SERVICE', jsonb_build_object('backfill', true), item.event_at)
      on conflict (queue_entry_id, kind) where queue_entry_id is not null do nothing;
      if found then
        update marketplace_clients set status_points = status_points + award
         where id = item.marketplace_client_id;
      end if;
    end if;
  end loop;
end $$;

create or replace function apply_marketplace_status_points_from_queue()
returns trigger
language plpgsql
as $$
declare
  marketplace_id uuid;
  points_config jsonb;
  level_config jsonb;
  points_amount integer;
  positive_today integer;
  no_show_count integer;
  block_threshold integer;
  old_level text;
  new_level text;
  earned_points integer;
begin
  if coalesce(new.source, '') <> 'site' then return new; end if;
  if tg_op = 'UPDATE' and old.status = new.status then return new; end if;

  if tg_op = 'UPDATE' and old.status = 'completed'
     and new.status in ('cancelled', 'rejected', 'no_show', 'not_in_time') then
    select marketplace_client_id into marketplace_id
      from status_point_transactions
     where queue_entry_id = new.id and kind = 'EARN';
  end if;
  if marketplace_id is null then
    select mc.id into marketplace_id
      from marketplace_clients mc
      join clients c on regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') =
                        regexp_replace(coalesce(mc.phone, ''), '[^0-9]', '', 'g')
                      and regexp_replace(coalesce(mc.phone, ''), '[^0-9]', '', 'g') <> ''
     where c.id = new.client_id limit 1;
  end if;
  if marketplace_id is null then return new; end if;

  perform 1 from marketplace_clients where id = marketplace_id for update;
  points_config := coalesce((select value from platform_settings where key = 'status_points'), '{}'::jsonb);

  if new.status = 'completed' then
    select marketplace_loyalty_level(status_points) into old_level
      from marketplace_clients where id = marketplace_id;
    points_amount := greatest(0, coalesce((points_config ->> 'completed_service_points')::integer, 10));
    update marketplace_clients set no_show_streak = 0 where id = marketplace_id;
    positive_today := coalesce((select sum(amount) from status_point_transactions
      where marketplace_client_id = marketplace_id and amount > 0
        and (created_at at time zone 'Asia/Tashkent')::date = (now() at time zone 'Asia/Tashkent')::date), 0);
    if positive_today + points_amount <= coalesce((points_config ->> 'daily_positive_limit')::integer, 100) then
      insert into status_point_transactions (marketplace_client_id, queue_entry_id, kind, amount, reason)
      values (marketplace_id, new.id, 'EARN', points_amount, 'COMPLETED_SERVICE')
      on conflict (queue_entry_id, kind) where queue_entry_id is not null do nothing;
      if found then
        update marketplace_clients set status_points = status_points + points_amount, no_show_streak = 0 where id = marketplace_id;
        select marketplace_loyalty_level(status_points) into new_level
          from marketplace_clients where id = marketplace_id;
        if old_level is distinct from new_level then
          insert into marketplace_notifications (marketplace_client_id, type, payload)
          values (marketplace_id, 'LEVEL_CHANGED', jsonb_build_object('old_level', old_level, 'new_level', new_level));
        end if;
      end if;
    end if;
  elsif tg_op = 'UPDATE' and old.status = 'completed' and new.status in ('cancelled', 'rejected', 'no_show', 'not_in_time') then
    select amount into earned_points from status_point_transactions
     where queue_entry_id = new.id and kind = 'EARN'
       and marketplace_client_id = marketplace_id;
    if earned_points > 0 then
      select marketplace_loyalty_level(status_points) into old_level
        from marketplace_clients where id = marketplace_id;
      insert into status_point_transactions (marketplace_client_id, queue_entry_id, kind, amount, reason, metadata)
      values (marketplace_id, new.id, 'REVERSAL', -earned_points, 'COMPLETED_SERVICE_CANCELLED',
              jsonb_build_object('reverses', 'EARN', 'previous_status', old.status, 'new_status', new.status))
      on conflict (queue_entry_id, kind) where queue_entry_id is not null do nothing;
      if found then
        update marketplace_clients set status_points = greatest(0, status_points - earned_points)
         where id = marketplace_id;
        select marketplace_loyalty_level(status_points) into new_level
          from marketplace_clients where id = marketplace_id;
        if old_level is distinct from new_level then
          insert into marketplace_notifications (marketplace_client_id, type, payload)
          values (marketplace_id, 'LEVEL_CHANGED', jsonb_build_object(
            'old_level', old_level, 'new_level', new_level, 'reason', 'COMPLETED_SERVICE_CANCELLED'));
        end if;
      end if;
    end if;
  end if;

  -- A completed order later corrected to no-show gets both its earned points
  -- reversed and the rank-specific no-show deduction.
  if new.status = 'no_show' then
    select marketplace_loyalty_level(status_points) into old_level
      from marketplace_clients where id = marketplace_id for update;
    select value -> old_level into level_config from platform_settings where key = 'loyalty_levels';
    points_amount := -greatest(0, coalesce(
      (level_config ->> 'no_show_penalty_points')::integer,
      abs((points_config ->> 'no_show_penalty')::integer), 30));
    insert into status_point_transactions (marketplace_client_id, queue_entry_id, kind, amount, reason)
    values (marketplace_id, new.id, 'PENALTY', points_amount, 'NO_SHOW')
    on conflict (queue_entry_id, kind) where queue_entry_id is not null do nothing;
    if found then
      update marketplace_clients set
        status_points = greatest(0, status_points + points_amount),
        no_show_streak = no_show_streak + 1
      where id = marketplace_id;
      select marketplace_loyalty_level(status_points) into new_level
        from marketplace_clients where id = marketplace_id;
      if old_level is distinct from new_level then
        insert into marketplace_notifications (marketplace_client_id, type, payload)
        values (marketplace_id, 'LEVEL_CHANGED', jsonb_build_object('old_level', old_level, 'new_level', new_level, 'reason', 'NO_SHOW'));
      end if;
      select no_show_streak into no_show_count from marketplace_clients where id = marketplace_id;
      block_threshold := coalesce((select (value ->> 'no_show_block_threshold')::integer from platform_settings where key = 'anti_fraud'), 5);
      if no_show_count >= block_threshold then
        update marketplace_clients
           set blocked_until = now() + make_interval(hours => coalesce((select (value ->> 'block_hours')::integer from platform_settings where key = 'anti_fraud'), 24))
         where id = marketplace_id;
        insert into marketplace_notifications (marketplace_client_id, type, payload)
        values (marketplace_id, 'ACCOUNT_BLOCKED', jsonb_build_object(
          'blocked_until', now() + make_interval(hours => coalesce((select (value ->> 'block_hours')::integer from platform_settings where key = 'anti_fraud'), 24)),
          'reason', 'NO_SHOW_LIMIT'));
      end if;
    end if;
  end if;
  return new;
end;
$$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'marketplace_clients_status_points_nonnegative'
       and conrelid = 'marketplace_clients'::regclass
  ) then
    alter table marketplace_clients validate constraint marketplace_clients_status_points_nonnegative;
  else
    alter table marketplace_clients validate constraint marketplace_clients_status_points_nonnegative;
  end if;
end $$;
