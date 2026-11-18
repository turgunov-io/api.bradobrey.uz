-- 003_tenant_composite_uniques — company-scoped uniqueness, ADDITIVE ONLY.
--
-- The new (company_id, x) unique indexes are created next to the existing
-- global ones. With the global constraint still present they change nothing
-- for the single-company deployment, and every current `on conflict (...)`
-- target keeps working. Dropping the global constraints is
-- db/migrations/007_drop_global_uniques.sql, which must ship together
-- with the API change (Phase 1 step B) — see MULTI_TENANCY.md section 9.
--
-- Semantics kept from today:
--   users.login            case-sensitive (code matches with .eq('login'))
--   clients.phone          exact text
--   promo_codes.code       exact text
--   certificates.code      exact text
--   warehouse_positions.sku exact, NULL allowed
--   warehouse_categories   lower(name)
--   referral_accounts.referral_code exact
-- users with company_id NULL (platform_owner, see 004) keep a global login namespace.
--
-- Singletons (kiosk_ad_settings, client_rank_settings, verifix_settings):
-- the `check (id = 1)` is dropped, `id` gets a sequence starting at 2 and
-- company_id becomes unique, so each company can own one row. Row id = 1 stays
-- Bradobrey's, so code that reads `id = 1` keeps working until step B.
-- platform_settings: unique (company_id, key) added; the PK on key alone is
-- swapped in 007_drop_global_uniques.
--
-- Rollback: db/migrations/down/003_tenant_composite_uniques.down.sql

create or replace function pg_temp.mt_exec_if_table(p_table text, p_sql text)
returns void
language plpgsql
as $$
begin
  if to_regclass(format('public.%I', p_table)) is null then
    raise notice 'multi-tenancy: table % does not exist, skipped: %', p_table, p_sql;
    return;
  end if;
  execute p_sql;
end;
$$;

select pg_temp.mt_exec_if_table('users',
  'create unique index if not exists users_company_login_uidx on users (company_id, login) where company_id is not null');
select pg_temp.mt_exec_if_table('users',
  'create unique index if not exists users_platform_login_uidx on users (login) where company_id is null');
select pg_temp.mt_exec_if_table('clients',
  'create unique index if not exists clients_company_phone_uidx on clients (company_id, phone)');
select pg_temp.mt_exec_if_table('promo_codes',
  'create unique index if not exists promo_codes_company_code_uidx on promo_codes (company_id, code)');
select pg_temp.mt_exec_if_table('certificates',
  'create unique index if not exists certificates_company_code_uidx on certificates (company_id, code)');
select pg_temp.mt_exec_if_table('warehouse_positions',
  'create unique index if not exists warehouse_positions_company_sku_uidx on warehouse_positions (company_id, sku) where sku is not null');
select pg_temp.mt_exec_if_table('warehouse_categories',
  'create unique index if not exists warehouse_categories_company_name_uidx on warehouse_categories (company_id, lower(name))');
select pg_temp.mt_exec_if_table('referral_accounts',
  'create unique index if not exists referral_accounts_company_code_uidx on referral_accounts (company_id, referral_code)');
select pg_temp.mt_exec_if_table('platform_settings',
  'create unique index if not exists platform_settings_company_key_uidx on platform_settings (company_id, key)');

create or replace function pg_temp.mt_company_singleton(p_table text)
returns void
language plpgsql
as $$
declare
  rel regclass := to_regclass(format('public.%I', p_table));
  check_name text;
  seq_name text := p_table || '_id_seq';
begin
  if rel is null then
    raise notice 'multi-tenancy: table % does not exist, skipped', p_table;
    return;
  end if;

  for check_name in
    select conname from pg_constraint
     where conrelid = rel and contype = 'c'
       and pg_get_constraintdef(oid) ~* '\(id = 1\)'
  loop
    execute format('alter table public.%I drop constraint %I', p_table, check_name);
  end loop;

  execute format('create sequence if not exists public.%I as integer start with 2 owned by public.%I.id', seq_name, p_table);
  execute format('select setval(%L, greatest(2, (select coalesce(max(id), 0) + 1 from public.%I)), false)', 'public.' || seq_name, p_table);
  execute format('alter table public.%I alter column id set default nextval(%L)', p_table, 'public.' || seq_name);
  execute format('create unique index if not exists %I on public.%I (company_id)', p_table || '_company_uidx', p_table);
end;
$$;

select pg_temp.mt_company_singleton('kiosk_ad_settings');
select pg_temp.mt_company_singleton('client_rank_settings');
select pg_temp.mt_company_singleton('verifix_settings');
