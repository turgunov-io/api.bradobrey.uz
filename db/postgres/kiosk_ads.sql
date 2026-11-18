-- Kiosk YouTube ads settings.
-- The kiosk can play multiple videos in sequence for:
-- - regular ads
-- - kids ads

create table if not exists kiosk_ad_settings (
  id integer primary key check (id = 1),
  regular_urls text[] not null default '{}'::text[],
  kids_urls text[] not null default '{}'::text[],
  updated_at timestamptz not null default now()
);

-- Seed row of the DEFAULT company, with company_id set explicitly (MULTI_TENANCY:
-- no reliance on the tenant trigger's default-company fallback, so
-- app.tenant_strict = 'on' can be enabled). On a fresh database (before
-- db/migrations 001–003 add company_id) the legacy id = 1 row is seeded.
do $$
begin
  if to_regclass('public.companies') is not null
     and exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'kiosk_ad_settings' and column_name = 'company_id') then
    insert into kiosk_ad_settings (company_id)
    select c.id
      from companies c
     where c.is_default
       and not exists (select 1 from kiosk_ad_settings s where s.company_id = c.id);
  else
    insert into kiosk_ad_settings (id) values (1) on conflict (id) do nothing;
  end if;
end $$;

create or replace function public.set_kiosk_ad_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_kiosk_ad_settings_updated_at on kiosk_ad_settings;
create trigger trg_kiosk_ad_settings_updated_at
before update on kiosk_ad_settings
for each row
execute function public.set_kiosk_ad_settings_updated_at();

