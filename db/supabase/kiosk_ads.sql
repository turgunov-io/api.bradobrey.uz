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

insert into kiosk_ad_settings (id)
values (1)
on conflict (id) do nothing;

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

