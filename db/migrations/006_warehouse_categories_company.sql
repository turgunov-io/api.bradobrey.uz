-- 006_warehouse_categories_company — MULTI_TENANCY Phase 1 step B2 (warehouse).
--
-- warehouse_categories used to be created lazily by src/models/warehouse.js
-- (runtime DDL that also re-created the GLOBAL unique index
-- idx_warehouse_categories_name). That runtime DDL is gone; the code now reads
-- and writes categories per company. If the table did not exist when 002/003
-- ran (they skip missing tables with a NOTICE), it never got company_id or the
-- per-company unique index — this migration closes that gap. On a database
-- where 002/003 already covered the table every statement is a no-op.
--
-- Does NOT drop the global indexes (idx_warehouse_categories_name,
-- idx_warehouse_positions_sku): that stays in 007_drop_global_uniques, which can now run
-- because nothing re-creates them (warehouse.sql and warehouse.js were fixed).
--
-- Rollback: db/migrations/down/006_warehouse_categories_company.down.sql

do $$
declare
  default_company uuid := public.tenant_default_company_id();
begin
  if default_company is null then
    raise exception 'multi-tenancy: default company missing (apply 001_companies first)';
  end if;

  create table if not exists public.warehouse_categories (
    id uuid default gen_random_uuid() primary key,
    name text not null,
    description text,
    sort_order integer not null default 0,
    is_active boolean not null default true,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  if not exists (
    select 1 from pg_attribute
     where attrelid = 'public.warehouse_categories'::regclass
       and attname = 'company_id' and not attisdropped
  ) then
    -- Constant default: no table rewrite; existing rows belong to company #1.
    execute format('alter table public.warehouse_categories add column company_id uuid default %L::uuid', default_company);
    alter table public.warehouse_categories alter column company_id drop default;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.warehouse_categories'::regclass
       and conname = 'warehouse_categories_company_id_fkey'
  ) then
    alter table public.warehouse_categories
      add constraint warehouse_categories_company_id_fkey
      foreign key (company_id) references public.companies(id) on delete restrict;
  end if;

  alter table public.warehouse_categories alter column company_id set not null;

  -- Same guard as every other tenant table (002): fills company_id on INSERT
  -- when the caller omits it (transitional fallback), honours app.tenant_strict.
  drop trigger if exists tenant_company_guard on public.warehouse_categories;
  create trigger tenant_company_guard
    before insert or update on public.warehouse_categories
    for each row execute function public.tenant_assign_company_id();
end $$;

create index if not exists idx_warehouse_categories_company
  on warehouse_categories (company_id, is_active, sort_order, name);

-- Per-company uniqueness (same name as 003, so this is a no-op when 003 made it).
create unique index if not exists warehouse_categories_company_name_uidx
  on warehouse_categories (company_id, lower(name));
