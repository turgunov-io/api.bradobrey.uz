-- 002_tenant_company_id — company_id on every tenant table (MULTI_TENANCY Phase 1, step A).
--
-- For each table below:
--   1. `company_id uuid` is added with company #1 (is_default) as a constant
--      default and the default is dropped right after. On PostgreSQL 11+ this
--      is metadata-only: no table rewrite even on queue_entries /
--      queue_status_events.
--   2. Only if companies other than #1 exist (barbershop split in 001), rows
--      whose parent (branch, barbershop, client, queue entry, ...) belongs to
--      another company are re-homed. User triggers are disabled for that
--      UPDATE (append-only audit tables, updated_at and recompute triggers),
--      and exactly the ones that were enabled are enabled again.
--   3. FK to companies, NOT NULL (users: see 004), index (company_id[, branch_id]).
--   4. Trigger `tenant_company_guard` (BEFORE INSERT OR UPDATE):
--        * company_id NULL  -> derived from the first non-null parent, else
--          company #1 (TRANSITIONAL fallback so existing inserts that do not
--          know about companies keep working; `set app.tenant_strict = 'on'`
--          turns the fallback into an error — target state after step B).
--        * company_id given -> must equal every non-null parent's company
--          (errcode 23514). This is the cross-company consistency guard:
--          a service, kiosk, user, queue entry, ... can never point at a
--          branch/barber/client/service of another company.
--        * UPDATE that does not touch company_id or a parent column: no-op.
--
-- Parent spec: 'column:parent_table' (lookup by parent.id uuid) or
-- 'column:parent_table:key_column:key_type'; 'skip_if:column=value' leaves
-- company_id alone for such rows (users.role = platform_owner).
--
-- Lock profile: ACCESS EXCLUSIVE per table for the ALTERs; SET NOT NULL, the
-- FK validation and index builds scan each table. Run in a maintenance window.
-- Rollback: db/migrations/down/002_tenant_company_id.down.sql

create or replace function public.tenant_default_company_id()
returns uuid
language sql
stable
as $$
  select id from public.companies where is_default limit 1
$$;

create or replace function public.tenant_assign_company_id()
returns trigger
language plpgsql
as $$
declare
  new_row jsonb := to_jsonb(new);
  old_row jsonb;
  parts text[];
  skip_rule text[];
  parent_company uuid;
  derived uuid;
  derived_from text;
  relevant_change boolean;
  i integer;
begin
  if tg_op = 'UPDATE' then
    old_row := to_jsonb(old);
    relevant_change := (new_row -> 'company_id') is distinct from (old_row -> 'company_id');
    for i in 0 .. tg_nargs - 1 loop
      parts := string_to_array(tg_argv[i], ':');
      if parts[1] <> 'skip_if' and (new_row -> parts[1]) is distinct from (old_row -> parts[1]) then
        relevant_change := true;
      end if;
    end loop;
    if not relevant_change then
      return new;
    end if;
  end if;

  for i in 0 .. tg_nargs - 1 loop
    parts := string_to_array(tg_argv[i], ':');

    if parts[1] = 'skip_if' then
      skip_rule := string_to_array(parts[2], '=');
      if (new_row ->> skip_rule[1]) = skip_rule[2] then
        return new;
      end if;
      continue;
    end if;

    continue when (new_row ->> parts[1]) is null;

    execute format(
      'select company_id from public.%I where %I = $1::%s',
      parts[2], coalesce(parts[3], 'id'), coalesce(parts[4], 'uuid')
    ) into parent_company using (new_row ->> parts[1]);

    continue when parent_company is null;

    if derived is null then
      derived := parent_company;
      derived_from := parts[1];
    elsif derived <> parent_company then
      raise exception using
        errcode = '23514',
        message = format('%s: %s and %s belong to different companies', tg_table_name, derived_from, parts[1]);
    end if;
  end loop;

  if new.company_id is null then
    if derived is null and coalesce(current_setting('app.tenant_strict', true), '') = 'on' then
      raise exception using
        errcode = '23502',
        message = format('%s.company_id is required (app.tenant_strict)', tg_table_name);
    end if;
    new.company_id := coalesce(derived, public.tenant_default_company_id());
  elsif derived is not null and new.company_id <> derived then
    raise exception using
      errcode = '23514',
      message = format('%s.company_id %s does not match the company %s of %s', tg_table_name, new.company_id, derived, derived_from);
  end if;

  return new;
end;
$$;

-- Migration-only helper (session temp schema, dropped with the connection).
create or replace function pg_temp.mt_tenantize(p_table text, p_parents text[], p_not_null boolean)
returns void
language plpgsql
as $$
declare
  rel regclass := to_regclass(format('public.%I', p_table));
  default_company uuid := public.tenant_default_company_id();
  derive_parts text[] := '{}';
  derive_expr text;
  parts text[];
  spec text;
  trig record;
  disabled text[] := '{}';
  trigger_args text;
  has_branch boolean;
begin
  if rel is null then
    raise notice 'multi-tenancy: table % does not exist, skipped', p_table;
    return;
  end if;
  if default_company is null then
    raise exception 'multi-tenancy: default company missing (apply 001_companies first)';
  end if;

  if not exists (
    select 1 from pg_attribute where attrelid = rel and attname = 'company_id' and not attisdropped
  ) then
    execute format('alter table public.%I add column company_id uuid default %L::uuid', p_table, default_company);
    execute format('alter table public.%I alter column company_id drop default', p_table);
  end if;

  foreach spec in array coalesce(p_parents, '{}'::text[]) loop
    parts := string_to_array(spec, ':');
    continue when parts[1] = 'skip_if';
    derive_parts := derive_parts || format(
      '(select p.company_id from public.%I p where p.%I = t.%I)',
      parts[2], coalesce(parts[3], 'id'), parts[1]
    );
  end loop;

  if array_length(derive_parts, 1) > 0
     and exists (select 1 from public.companies where id <> default_company) then
    derive_expr := 'coalesce(' || array_to_string(derive_parts, ', ') || ')';

    for trig in
      select tgname from pg_trigger where tgrelid = rel and not tgisinternal and tgenabled = 'O'
    loop
      execute format('alter table public.%I disable trigger %I', p_table, trig.tgname);
      disabled := disabled || trig.tgname::text;
    end loop;

    execute format(
      'update public.%I as t set company_id = %s where %s is not null and %s is distinct from t.company_id',
      p_table, derive_expr, derive_expr, derive_expr
    );

    foreach spec in array disabled loop
      execute format('alter table public.%I enable trigger %I', p_table, spec);
    end loop;
  end if;

  if not exists (
    select 1 from pg_constraint where conrelid = rel and conname = p_table || '_company_id_fkey'
  ) then
    execute format(
      'alter table public.%I add constraint %I foreign key (company_id) references public.companies(id) on delete restrict',
      p_table, p_table || '_company_id_fkey'
    );
  end if;

  if p_not_null then
    execute format('alter table public.%I alter column company_id set not null', p_table);
  end if;

  has_branch := exists (
    select 1 from pg_attribute where attrelid = rel and attname = 'branch_id' and not attisdropped
  );
  execute format(
    'create index if not exists %I on public.%I (%s)',
    'idx_' || p_table || '_company', p_table,
    case when has_branch then 'company_id, branch_id' else 'company_id' end
  );

  select coalesce(string_agg(quote_literal(arg), ', ' order by ord), '')
    into trigger_args
    from unnest(coalesce(p_parents, '{}'::text[])) with ordinality as a(arg, ord);

  execute format('drop trigger if exists tenant_company_guard on public.%I', p_table);
  execute format(
    'create trigger tenant_company_guard before insert or update on public.%I for each row execute function public.tenant_assign_company_id(%s)',
    p_table, trigger_args
  );
end;
$$;

-- Order matters: a parent is migrated before the tables that derive from it.
-- Organisation
select pg_temp.mt_tenantize('branches', array['marketplace_barbershop_id:marketplace_barbershops'], true);
select pg_temp.mt_tenantize('users', array[
  'skip_if:role=platform_owner',
  'branch_id:branches',
  'marketplace_barbershop_id:marketplace_barbershops'
], false);
select pg_temp.mt_tenantize('barbers', array['branch_id:branches', 'id:users'], true);
select pg_temp.mt_tenantize('employee_branch_access', array['branch_id:branches', 'employee_id:users'], true);
select pg_temp.mt_tenantize('employee_active_branches', array['branch_id:branches', 'employee_id:users'], true);
select pg_temp.mt_tenantize('kiosks', array['branch_id:branches'], true);
select pg_temp.mt_tenantize('branch_locations', array['branch_id:branches'], true);
select pg_temp.mt_tenantize('barber_login_location_events', array['branch_id:branches', 'barber_id:barbers'], true);

-- Catalogue and prices
select pg_temp.mt_tenantize('service_categories', array['branch_id:branches', 'marketplace_barbershop_id:marketplace_barbershops'], true);
select pg_temp.mt_tenantize('services', array['branch_id:branches', 'marketplace_barbershop_id:marketplace_barbershops'], true);

-- Clients and money (owner decision: same phone in two companies = two clients)
select pg_temp.mt_tenantize('clients', '{}'::text[], true);
select pg_temp.mt_tenantize('cashback_wallets', array['client_id:clients'], true);
select pg_temp.mt_tenantize('cashback_transactions', array['client_id:clients'], true);
select pg_temp.mt_tenantize('cashback_settlements', array['branch_id:branches', 'client_id:clients'], true);
select pg_temp.mt_tenantize('cashback_reconciliation_alerts', array['client_id:clients'], true);
select pg_temp.mt_tenantize('promo_codes', array['marketplace_barbershop_id:marketplace_barbershops'], true);
select pg_temp.mt_tenantize('promo_code_usage', array['promo_code_id:promo_codes'], true);
select pg_temp.mt_tenantize('certificates', array['marketplace_barbershop_id:marketplace_barbershops'], true);

-- Content and settings (singletons become per-company in 003)
select pg_temp.mt_tenantize('banners', '{}'::text[], true);
select pg_temp.mt_tenantize('media_assets', array['barber_id:barbers'], true);
select pg_temp.mt_tenantize('kiosk_ad_settings', '{}'::text[], true);
select pg_temp.mt_tenantize('client_rank_settings', '{}'::text[], true);
select pg_temp.mt_tenantize('verifix_settings', '{}'::text[], true);
select pg_temp.mt_tenantize('platform_settings', '{}'::text[], true);

-- Warehouse, expenses/penalties (expenses live in warehouse_purchases)
select pg_temp.mt_tenantize('warehouse_positions', '{}'::text[], true);
select pg_temp.mt_tenantize('warehouse_templates', '{}'::text[], true);
select pg_temp.mt_tenantize('warehouse_template_items', array['template_id:warehouse_templates', 'position_id:warehouse_positions'], true);
select pg_temp.mt_tenantize('warehouse_stocks', array['branch_id:branches', 'position_id:warehouse_positions'], true);
select pg_temp.mt_tenantize('warehouse_purchases', array['branch_id:branches'], true);
select pg_temp.mt_tenantize('warehouse_purchase_items', array['purchase_id:warehouse_purchases', 'position_id:warehouse_positions'], true);
select pg_temp.mt_tenantize('warehouse_categories', '{}'::text[], true);
select pg_temp.mt_tenantize('expenses', array['branch_id:branches', 'created_by:users'], true);

-- Queue, payments, finance, notifications
select pg_temp.mt_tenantize('queue_entries', array[
  'branch_id:branches',
  'barber_id:barbers',
  'service_id:services',
  'client_id:clients',
  'certificate_id:certificates'
], true);
select pg_temp.mt_tenantize('payments', array['queue_entry_id:queue_entries'], true);
select pg_temp.mt_tenantize('finance_snapshots', array['branch_id:branches'], true);
select pg_temp.mt_tenantize('notifications', array['branch_id:branches', 'order_id:queue_entries', 'recipient_user_id:users'], true);

-- Verifix (schedules, attendance)
select pg_temp.mt_tenantize('barber_work_schedules', array['branch_id:branches', 'barber_id:barbers'], true);
select pg_temp.mt_tenantize('barber_activity_events', array['branch_id:branches', 'barber_id:barbers'], true);

-- Queue history / employee quality (append-only audit tables)
select pg_temp.mt_tenantize('queue_status_events', array['queue_entry_id:queue_entries', 'branch_id:branches'], true);
select pg_temp.mt_tenantize('queue_transfer_events', array['queue_entry_id:queue_entries', 'to_barber_id:barbers'], true);
select pg_temp.mt_tenantize('queue_quality_assessments', array['queue_entry_id:queue_entries', 'branch_id:branches'], true);
select pg_temp.mt_tenantize('queue_quality_review_events', array['queue_entry_id:queue_entries'], true);
select pg_temp.mt_tenantize('queue_quality_plan_snapshots', array['queue_entry_id:queue_entries'], true);

-- Marketplace rows that are clearly one barbershop's data
select pg_temp.mt_tenantize('marketplace_reviews', array['barbershop_id:marketplace_barbershops', 'barber_id:barbers'], true);
select pg_temp.mt_tenantize('marketplace_review_alerts', array['barbershop_id:marketplace_barbershops', 'review_id:marketplace_reviews'], true);
select pg_temp.mt_tenantize('client_barbershop_origins', array['barbershop_id:marketplace_barbershops'], true);
select pg_temp.mt_tenantize('marketplace_no_show_violations', array['queue_entry_id:queue_entries'], true);

-- Referral programme
select pg_temp.mt_tenantize('referral_accounts', '{}'::text[], true);
select pg_temp.mt_tenantize('referrals', array['referral_code:referral_accounts:referral_code:text'], true);
select pg_temp.mt_tenantize('referral_transactions', array['referral_id:referrals'], true);

-- Hot company-wide read paths (in addition to idx_<table>_company).
do $$
begin
  if to_regclass('public.queue_entries') is not null then
    create index if not exists idx_queue_entries_company_created on queue_entries (company_id, created_at desc);
  end if;
  if to_regclass('public.users') is not null then
    create index if not exists idx_users_company_role on users (company_id, role);
  end if;
  if to_regclass('public.services') is not null then
    create index if not exists idx_services_company_active on services (company_id, is_active);
  end if;
  if to_regclass('public.cashback_transactions') is not null then
    create index if not exists idx_cashback_transactions_company_created on cashback_transactions (company_id, created_at desc);
  end if;
  if to_regclass('public.barber_activity_events') is not null then
    create index if not exists idx_barber_activity_events_company_time on barber_activity_events (company_id, occurred_at desc);
  end if;
end $$;
