-- Rollback of 003_tenant_composite_uniques. Run the 004 down first.
-- Run manually in one transaction:  psql -v ON_ERROR_STOP=1 -1 -f <file>
-- Singleton rows of companies other than #1 must be removed first, otherwise
-- re-adding check (id = 1) fails:
--   delete from kiosk_ad_settings    where id <> 1;
--   delete from client_rank_settings where id <> 1;
--   delete from verifix_settings     where id <> 1;

drop index if exists users_company_login_uidx;
drop index if exists users_platform_login_uidx;
drop index if exists clients_company_phone_uidx;
drop index if exists promo_codes_company_code_uidx;
drop index if exists certificates_company_code_uidx;
drop index if exists warehouse_positions_company_sku_uidx;
drop index if exists warehouse_categories_company_name_uidx;
drop index if exists referral_accounts_company_code_uidx;
drop index if exists platform_settings_company_key_uidx;

do $$
declare
  t text;
begin
  foreach t in array array['kiosk_ad_settings', 'client_rank_settings', 'verifix_settings'] loop
    continue when to_regclass(format('public.%I', t)) is null;
    execute format('drop index if exists public.%I', t || '_company_uidx');
    execute format('alter table public.%I alter column id drop default', t);
    execute format('drop sequence if exists public.%I', t || '_id_seq');
    execute format('alter table public.%I add constraint %I check (id = 1)', t, t || '_id_check');
  end loop;
end $$;

delete from schema_migrations where version = '003';
