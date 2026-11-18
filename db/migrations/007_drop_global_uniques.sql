-- 007_drop_global_uniques — MULTI_TENANCY Phase 1 (was deferred/101).
--
-- Effect: the same login / client phone / promo code / certificate code /
-- SKU / category name / referral code may exist in two companies, and
-- platform_settings becomes keyed by (company_id, key).
--
-- Ships in the SAME release as the Phase 1 step B code. Preconditions, all
-- done in code and guarded by tests:
--   * every ON CONFLICT / .upsert target in src/ and db/postgres matches a
--     unique key that exists after this migration
--     (test/onConflictTargets.test.js builds the key catalog from the SQL);
--   * platform_settings is read per company only (tenant_setting(key, company)
--     from 005, or company_id = ... in JS; test/companyMarketplaceKeys.test.js
--     fails on a key-only read);
--   * lookups by login / phone / promo code / certificate code / SKU are
--     company scoped; referral codes resolve to exactly one account
--     (src/utils/referralAccounts.js) and are generated unique platform-wide;
--   * db/postgres/warehouse.sql and src/models/warehouse.js no longer
--     (re)create idx_warehouse_positions_sku / idx_warehouse_categories_name.
--
-- Before applying: db/checks/multi_tenancy_checks.sql section D must report 0
-- problem rows (no duplicate login / phone / code inside one company).
--
-- Rollback: db/migrations/down/007_drop_global_uniques.down.sql — recreates
-- the global constraints; fails once duplicates exist across companies.

create or replace function pg_temp.mt_drop_single_column_unique(p_table text, p_column text)
returns void
language plpgsql
as $$
declare
  rel regclass := to_regclass(format('public.%I', p_table));
  item record;
begin
  if rel is null then
    return;
  end if;
  for item in
    select c.conname
      from pg_constraint c
     where c.conrelid = rel
       and c.contype = 'u'
       and c.conkey = array[(select attnum from pg_attribute where attrelid = rel and attname = p_column)]::int2[]
  loop
    execute format('alter table public.%I drop constraint %I', p_table, item.conname);
  end loop;
end;
$$;

select pg_temp.mt_drop_single_column_unique('users', 'login');
select pg_temp.mt_drop_single_column_unique('clients', 'phone');
select pg_temp.mt_drop_single_column_unique('promo_codes', 'code');
select pg_temp.mt_drop_single_column_unique('certificates', 'code');

drop index if exists idx_warehouse_positions_sku;
drop index if exists idx_warehouse_categories_name;

-- referrals.referral_code -> referral_accounts(referral_code) depends on the
-- global unique; re-point it at (company_id, referral_code).
do $$
begin
  if to_regclass('public.referral_accounts') is null then
    return;
  end if;
  alter table referrals drop constraint if exists referrals_referral_code_fkey;
  perform pg_temp.mt_drop_single_column_unique('referral_accounts', 'referral_code');
  if not exists (select 1 from pg_constraint where conname = 'referral_accounts_company_code_key') then
    alter table referral_accounts
      add constraint referral_accounts_company_code_key unique using index referral_accounts_company_code_uidx;
  end if;
  alter table referrals
    add constraint referrals_company_referral_code_fkey
    foreign key (company_id, referral_code)
    references referral_accounts (company_id, referral_code)
    on delete restrict;
end $$;

-- platform_settings: per-company key.
alter table platform_settings drop constraint if exists platform_settings_pkey;
alter table platform_settings
  add constraint platform_settings_pkey primary key using index platform_settings_company_key_uidx;
