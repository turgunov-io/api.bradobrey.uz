-- Rollback of 007_drop_global_uniques (formerly deferred/101).
-- Fails if duplicates now exist across companies; resolve those first.
-- Run manually in one transaction:  psql -v ON_ERROR_STOP=1 -1 -f <file>

alter table users add constraint users_login_key unique (login);
alter table clients add constraint clients_phone_key unique (phone);
alter table promo_codes add constraint promo_codes_code_key unique (code);
alter table certificates add constraint certificates_code_key unique (code);
create unique index if not exists idx_warehouse_positions_sku on warehouse_positions (sku) where sku is not null;
create unique index if not exists idx_warehouse_categories_name on warehouse_categories (lower(name));

alter table referrals drop constraint if exists referrals_company_referral_code_fkey;
alter table referral_accounts add constraint referral_accounts_referral_code_key unique (referral_code);
alter table referrals
  add constraint referrals_referral_code_fkey
  foreign key (referral_code) references referral_accounts (referral_code) on delete restrict;

alter table platform_settings drop constraint if exists platform_settings_pkey;
alter table platform_settings add constraint platform_settings_pkey primary key (key);
create unique index if not exists platform_settings_company_key_uidx on platform_settings (company_id, key);
delete from schema_migrations where version = '007';
