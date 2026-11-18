-- 005_company_scoped_functions — MULTI_TENANCY Phase 1 step B2a.
--
-- Database functions that read settings or match clients by phone become
-- company-aware. The company is always derived from the row being processed
-- (queue_entries.company_id, clients.company_id, the settings row), never
-- "any company where this phone exists":
--   tenant_setting(key, company)          platform_settings value of ONE company
--                                         (NULL company = default company; a
--                                         company without the row gets NULL, so
--                                         callers use their built-in defaults —
--                                         settings never leak between companies)
--   marketplace_loyalty_level(points, company) / (points)
--   apply_marketplace_status_points_from_queue()   settings of new.company_id
--   apply_referral_bonus_from_completed_queue()    referral + wallet client of
--                                         new.company_id; clients upsert on
--                                         (company_id, phone)
--   apply_marketplace_referral_bonus_from_queue()  no-op (its trigger was
--                                         dropped long ago; kept so a stray
--                                         trigger cannot write cross-company)
--   recompute_company_client_ranks(company), recompute_client_rank(client),
--   recompute_all_client_ranks(), on_client_rank_settings_changed()
--                                         client_rank_settings per company
--
-- After this migration nothing in these functions depends on the global
-- uniques dropped by 007 (clients.phone, platform_settings.key).
--
-- The SAME definitions live in the base schema files that apply-schema.sh
-- re-runs on every deploy (db/postgres/marketplace_tz_compliance.sql,
-- loyalty_points_reversal.sql, client_ranks.sql); test/companySqlFunctions.test.js
-- fails if they drift. Bodies are plpgsql (checked at call time) so the base
-- files still load on a fresh database before 001–004 have run.
--
-- Rollback: db/migrations/down/005_company_scoped_functions.down.sql
-- (re-run the previous base files: ./scripts/apply-schema.sh from the
-- previous release).

create or replace function tenant_setting(p_key text, p_company_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  setting_value jsonb;
begin
  if p_company_id is not null then
    select ps.value into setting_value
      from platform_settings ps
     where ps.company_id = p_company_id
       and ps.key = p_key;
    return setting_value;
  end if;
  -- No company (legacy callers, fresh schema before the tenant migrations):
  -- the default company's row.
  if to_regclass('public.companies') is null then
    select ps.value into setting_value from platform_settings ps where ps.key = p_key limit 1;
    return setting_value;
  end if;
  select ps.value into setting_value
    from platform_settings ps
    join companies c on c.id = ps.company_id and c.is_default
   where ps.key = p_key
   limit 1;
  return setting_value;
end;
$$;

create or replace function marketplace_loyalty_level(points integer, p_company_id uuid)
returns text
language plpgsql
stable
as $$
begin
  return coalesce((
    select level_name
      from jsonb_each(coalesce(tenant_setting('loyalty_levels', p_company_id), '{}'::jsonb)) as levels(level_name, config)
     where coalesce((config ->> 'min_points')::integer, 0) <= coalesce(points, 0)
     order by coalesce((config ->> 'min_points')::integer, 0) desc
     limit 1
  ), 'NONE');
end;
$$;

create or replace function marketplace_loyalty_level(points integer)
returns text
language plpgsql
stable
as $$
begin
  -- Marketplace clients are global until Phase 5: without a company the
  -- default company's levels apply.
  return marketplace_loyalty_level(points, null::uuid);
end;
$$;

create or replace function apply_marketplace_status_points_from_queue()
returns trigger
language plpgsql
as $$
declare
  marketplace_id uuid;
  points_config jsonb;
  anti_fraud_config jsonb;
  level_config jsonb;
  points_amount integer;
  positive_today integer;
  no_show_count integer;
  block_threshold integer;
  block_hours integer;
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
    -- new.client_id is a client of new.company_id; map it to the (global)
    -- marketplace account by phone.
    select mc.id into marketplace_id
      from marketplace_clients mc
      join clients c on regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') =
                        regexp_replace(coalesce(mc.phone, ''), '[^0-9]', '', 'g')
                      and regexp_replace(coalesce(mc.phone, ''), '[^0-9]', '', 'g') <> ''
     where c.id = new.client_id limit 1;
  end if;
  if marketplace_id is null then return new; end if;

  perform 1 from marketplace_clients where id = marketplace_id for update;
  -- Rules of the company that served the order.
  points_config := coalesce(tenant_setting('status_points', new.company_id), '{}'::jsonb);
  anti_fraud_config := coalesce(tenant_setting('anti_fraud', new.company_id), '{}'::jsonb);

  if new.status = 'completed' then
    select marketplace_loyalty_level(status_points, new.company_id) into old_level
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
        select marketplace_loyalty_level(status_points, new.company_id) into new_level
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
      select marketplace_loyalty_level(status_points, new.company_id) into old_level
        from marketplace_clients where id = marketplace_id;
      insert into status_point_transactions (marketplace_client_id, queue_entry_id, kind, amount, reason, metadata)
      values (marketplace_id, new.id, 'REVERSAL', -earned_points, 'COMPLETED_SERVICE_CANCELLED',
              jsonb_build_object('reverses', 'EARN', 'previous_status', old.status, 'new_status', new.status))
      on conflict (queue_entry_id, kind) where queue_entry_id is not null do nothing;
      if found then
        update marketplace_clients set status_points = greatest(0, status_points - earned_points)
         where id = marketplace_id;
        select marketplace_loyalty_level(status_points, new.company_id) into new_level
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
    select marketplace_loyalty_level(status_points, new.company_id) into old_level
      from marketplace_clients where id = marketplace_id for update;
    level_config := coalesce(tenant_setting('loyalty_levels', new.company_id), '{}'::jsonb) -> old_level;
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
      select marketplace_loyalty_level(status_points, new.company_id) into new_level
        from marketplace_clients where id = marketplace_id;
      if old_level is distinct from new_level then
        insert into marketplace_notifications (marketplace_client_id, type, payload)
        values (marketplace_id, 'LEVEL_CHANGED', jsonb_build_object('old_level', old_level, 'new_level', new_level, 'reason', 'NO_SHOW'));
      end if;
      select no_show_streak into no_show_count from marketplace_clients where id = marketplace_id;
      block_threshold := coalesce((anti_fraud_config ->> 'no_show_block_threshold')::integer, 5);
      block_hours := coalesce((anti_fraud_config ->> 'block_hours')::integer, 24);
      if no_show_count >= block_threshold then
        update marketplace_clients
           set blocked_until = now() + make_interval(hours => block_hours)
         where id = marketplace_id;
        insert into marketplace_notifications (marketplace_client_id, type, payload)
        values (marketplace_id, 'ACCOUNT_BLOCKED', jsonb_build_object(
          'blocked_until', now() + make_interval(hours => block_hours),
          'reason', 'NO_SHOW_LIMIT'));
      end if;
    end if;
  end if;
  return new;
end;
$$;

create or replace function apply_marketplace_referral_bonus_from_queue()
returns trigger
language plpgsql
as $$
begin
  -- Superseded by apply_referral_bonus_from_completed_queue() and
  -- services/referralBonus.js; its trigger is no longer created. Kept as a
  -- no-op so a stray trigger cannot write cross-company wallet rows.
  return new;
end;
$$;

create or replace function apply_referral_bonus_from_completed_queue()
returns trigger
language plpgsql
as $$
declare
  referral_row record;
  paid_money numeric(12,2) := 0;
  payment_rows integer := 0;
  bonus_percent numeric := 1;
  bonus_amount numeric(12,2) := 0;
  referral_transaction_id uuid;
  referrer_phone text;
  referrer_name text;
  cashback_client_id uuid;
begin
  if new.status <> 'completed'
     or (tg_op = 'UPDATE' and old.status = new.status)
     or new.client_id is null
     or new.company_id is null then
    return new;
  end if;

  -- new.client_id is the client of new.company_id that was served. Only a
  -- referral of the same company is settled (marketplace accounts stay global
  -- until Phase 5; the company is never guessed from the phone).
  select r.id,
         r.referrer_client_id,
         r.expires_at,
         linked_booking.booking_id
    into referral_row
    from referrals r
    join marketplace_clients referred_mc
      on referred_mc.id = r.referred_client_id
    join clients referred_c
      on regexp_replace(coalesce(referred_c.phone, ''), '[^0-9]', '', 'g') =
         regexp_replace(coalesce(referred_mc.phone, ''), '[^0-9]', '', 'g')
     and regexp_replace(coalesce(referred_mc.phone, ''), '[^0-9]', '', 'g') <> ''
    left join lateral (
      select bp.booking_id
        from marketplace_booking_persons bp
       where bp.queue_entry_id = new.id
       order by bp.booking_id
       limit 1
    ) linked_booking on true
   where r.referred_client_id = referred_mc.id
     and referred_c.id = new.client_id
     and r.company_id = new.company_id
     and r.expires_at > now()
   order by r.created_at asc
   limit 1;

  if referral_row.id is null then
    return new;
  end if;

  select coalesce(sum(p.amount) filter (where p.method in ('payme', 'click', 'cash', 'card')), 0),
         count(*) filter (where p.id is not null)
    into paid_money, payment_rows
    from payments p
   where p.queue_entry_id = new.id;

  -- Application settlement handles legacy rows without payment records after
  -- completion. The trigger must not guess the amount because promo discounts
  -- and cashback spending may be written immediately after the status update.
  if payment_rows = 0 or paid_money <= 0 then
    return new;
  end if;

  bonus_percent := coalesce((tenant_setting('referral', new.company_id) ->> 'bonus_percent')::numeric, 1);
  bonus_amount := floor(paid_money * bonus_percent / 100);
  if bonus_amount <= 0 then
    return new;
  end if;

  insert into referral_transactions
    (referral_id, booking_id, queue_entry_id, amount, paid_with_money)
  values
    (referral_row.id, referral_row.booking_id, new.id, bonus_amount, paid_money)
  on conflict (referral_id, queue_entry_id) where queue_entry_id is not null
  do nothing
  returning id into referral_transaction_id;

  if referral_transaction_id is null then
    return new;
  end if;

  select phone, coalesce(nullif(display_name, ''), 'Client')
    into referrer_phone, referrer_name
    from marketplace_clients
   where id = referral_row.referrer_client_id;

  -- A referrer without a phone cannot yet be mapped to the legacy wallet.
  -- Keep referral_transactions; the application recovery job will credit it
  -- as soon as the phone is attached.
  if referrer_phone is null or referrer_phone = '' then
    return new;
  end if;

  -- The referrer's wallet client in the SAME company (same phone in another
  -- company is another client, D3).
  select id into cashback_client_id
    from clients
   where company_id = new.company_id
     and regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') =
         regexp_replace(referrer_phone, '[^0-9]', '', 'g')
   order by (phone = referrer_phone) desc, id
   limit 1;

  if cashback_client_id is null then
    insert into clients (company_id, name, phone)
    values (new.company_id, referrer_name, referrer_phone)
    on conflict (company_id, phone) do update
      set name = coalesce(nullif(clients.name, ''), excluded.name)
    returning id into cashback_client_id;
  end if;

  insert into cashback_wallets (client_id, balance)
  values (cashback_client_id, 0)
  on conflict (client_id) do nothing;

  insert into cashback_transactions
    (client_id, kind, amount, meta, request_id)
  values (
    cashback_client_id,
    'adjust',
    bonus_amount,
    jsonb_build_object(
      'source', 'referral_bonus',
      'booking_id', referral_row.booking_id,
      'queue_entry_id', new.id,
      'referral_transaction_id', referral_transaction_id,
      'description', 'Referral bonus'
    ),
    'referral_bonus:' || referral_transaction_id::text
  )
  on conflict (request_id) where request_id is not null do nothing;

  if found then
    update cashback_wallets
       set balance = round((balance + bonus_amount)::numeric, 2),
           updated_at = now()
     where client_id = cashback_client_id;
  end if;

  return new;
end;
$$;

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
