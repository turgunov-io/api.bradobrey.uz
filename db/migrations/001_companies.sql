-- 001_companies — tenant root table (MULTI_TENANCY Phase 1, step A).
--
-- Owner decision 2026-11-18: one company = one marketplace barbershop (brand)
-- = unlimited branches. Bradobrey becomes company #1 (`is_default`), which
-- also serves as the transitional fallback tenant until the API passes
-- company_id explicitly (see 002 and MULTI_TENANCY.md section 9).
--
-- Session settings (set by `npm run migrate` from MIGRATE_* env vars, or with
-- `set app.x = '...'` in psql):
--   app.seed_company_code      code of company #1, default 'BRADOBREY'
--   app.seed_company_name      name of company #1, default 'Bradobrey'
--   app.seed_barbershop_id     barbershop that IS Bradobrey; default = the
--                              barbershop with the most branches (oldest wins a tie)
--   app.allow_barbershop_split 'on' to allow moving another barbershop's
--                              branches into its own company (see below)
--
-- Rollback: db/migrations/down/001_companies.down.sql

create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null,
  status text not null default 'active',
  currency text not null default 'UZS',
  timezone text not null default 'Asia/Tashkent',
  logo_url text,
  primary_color text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_status_check check (status in ('active', 'suspended')),
  constraint companies_name_not_blank check (btrim(name) <> ''),
  -- Typed by people on the kiosk/barber login screen: short, no spaces.
  constraint companies_code_format check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$')
);

-- Company code is unique case-insensitively (kiosk/barber enter it by hand).
create unique index if not exists companies_code_lower_uidx on companies (lower(code));
-- At most one fallback/default company (Bradobrey).
create unique index if not exists companies_single_default_uidx on companies (is_default) where is_default;

create or replace function public.set_companies_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_companies_updated_at on companies;
create trigger trg_companies_updated_at
before update on companies
for each row
execute function public.set_companies_updated_at();

insert into companies (name, code, is_default)
select coalesce(nullif(btrim(current_setting('app.seed_company_name', true)), ''), 'Bradobrey'),
       upper(coalesce(nullif(btrim(current_setting('app.seed_company_code', true)), ''), 'BRADOBREY')),
       true
where not exists (select 1 from companies where is_default);

-- 1:1 company <-> marketplace barbershop. Nullable for now: the marketplace
-- admin create-barbershop path does not set it yet (Phase 1 step B).
alter table marketplace_barbershops
  add column if not exists company_id uuid unique references companies(id) on delete restrict;

-- Backfill.
--  * The primary barbershop (app.seed_barbershop_id, else most branches) is
--    linked to company #1.
--  * Every other barbershop gets its own company (code SHOP_<8 hex of id>,
--    rename later), because the merchant cabinet already treats barbershops
--    as separate businesses and the owner decided 1:1.
--  * Moving LIVE branches out of Bradobrey is not done silently: if a
--    non-primary barbershop owns branches, the migration aborts unless
--    app.allow_barbershop_split = 'on'. Run db/checks/multi_tenancy_checks.sql
--    (preflight section) first and decide.
do $$
declare
  default_company uuid;
  primary_shop uuid;
  configured_shop text := nullif(btrim(current_setting('app.seed_barbershop_id', true)), '');
  allow_split boolean := coalesce(current_setting('app.allow_barbershop_split', true), '') = 'on';
  shop record;
  new_company uuid;
  split_branches integer;
begin
  select id into default_company from companies where is_default;

  if configured_shop is not null then
    select id into primary_shop from marketplace_barbershops where id = configured_shop::uuid;
    if primary_shop is null then
      raise exception 'app.seed_barbershop_id % does not exist in marketplace_barbershops', configured_shop;
    end if;
  else
    select mb.id into primary_shop
      from marketplace_barbershops mb
      left join branches b on b.marketplace_barbershop_id = mb.id
     group by mb.id, mb.created_at
     order by count(b.id) desc, mb.created_at asc, mb.id asc
     limit 1;
  end if;

  if primary_shop is not null then
    update marketplace_barbershops
       set company_id = default_company
     where id = primary_shop
       and company_id is null
       and not exists (select 1 from marketplace_barbershops where company_id = default_company);
  end if;

  select count(*) into split_branches
    from branches b
    join marketplace_barbershops mb on mb.id = b.marketplace_barbershop_id
   where mb.company_id is null;

  if split_branches > 0 and not allow_split then
    raise exception 'multi-tenancy backfill: % branch(es) belong to barbershops other than the primary one (%); they would move to separate companies. Review the preflight in db/checks/multi_tenancy_checks.sql, then set app.seed_barbershop_id or app.allow_barbershop_split = on',
      split_branches, primary_shop;
  end if;

  for shop in
    select mb.id, mb.name, mb.logo_url, mb.timezone
      from marketplace_barbershops mb
     where mb.company_id is null
     order by mb.created_at, mb.id
  loop
    -- Extra companies start suspended: activating one is the platform
    -- owner's decision and goes through the multi-company preconditions gate
    -- (POST/PATCH /api/platform/companies). An active second company would
    -- immediately switch off legacy single-company paths (dash login without
    -- company_code, kiosks without device token).
    insert into companies (name, code, logo_url, timezone, status)
    values (
      coalesce(nullif(btrim(shop.name), ''), 'Barbershop'),
      'SHOP_' || upper(substr(replace(shop.id::text, '-', ''), 1, 8)),
      shop.logo_url,
      coalesce(nullif(btrim(shop.timezone), ''), 'Asia/Tashkent'),
      'suspended'
    )
    returning id into new_company;

    update marketplace_barbershops set company_id = new_company where id = shop.id;
  end loop;
end $$;
