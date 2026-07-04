-- Marketplace home banners (carousel/promo slots).
-- Backs src/models/marketplace/banner.js and /api/marketplace/banners.
-- Columns mirror the fields read/written by the model:
--   image_url, title_{uz,ru,en}, description_{uz,ru,en}, is_active, sort_order.

create table if not exists banners (
  id uuid default gen_random_uuid() primary key,
  image_url text not null,
  title_uz text,
  title_ru text,
  title_en text,
  description_uz text,
  description_ru text,
  description_en text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Safety ALTERs so re-running on a partially-created table converges.
alter table banners add column if not exists image_url text;
alter table banners add column if not exists title_uz text;
alter table banners add column if not exists title_ru text;
alter table banners add column if not exists title_en text;
alter table banners add column if not exists description_uz text;
alter table banners add column if not exists description_ru text;
alter table banners add column if not exists description_en text;
alter table banners add column if not exists is_active boolean not null default true;
alter table banners add column if not exists sort_order integer not null default 0;
alter table banners add column if not exists created_at timestamptz not null default now();
alter table banners add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_banners_active_sort
  on banners (is_active, sort_order, created_at);

create or replace function public.set_banners_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_banners_updated_at on banners;
create trigger trg_banners_updated_at
before update on banners
for each row
execute function public.set_banners_updated_at();
