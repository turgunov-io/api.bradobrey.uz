create table if not exists marketplace_barbershops (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  description text,
  logo_url text,
  cover_url text,
  city text,
  address text,
  work_hours jsonb,
  timezone text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table branches
  add column if not exists marketplace_barbershop_id uuid references marketplace_barbershops(id) on delete set null;

alter table promo_codes
  add column if not exists marketplace_barbershop_id uuid references marketplace_barbershops(id) on delete set null;

alter table if exists certificates
  add column if not exists marketplace_barbershop_id uuid references marketplace_barbershops(id) on delete set null;

create index if not exists idx_marketplace_barbershops_active
  on marketplace_barbershops (is_active, sort_order, name);

create index if not exists idx_branches_marketplace_barbershop
  on branches (marketplace_barbershop_id, is_active);

create index if not exists idx_promo_codes_marketplace_barbershop
  on promo_codes (marketplace_barbershop_id, status);

do $$
begin
  if to_regclass('public.certificates') is not null then
    create index if not exists idx_certificates_marketplace_barbershop
      on certificates (marketplace_barbershop_id, is_used);
  end if;
end $$;

insert into marketplace_barbershops (
  name,
  city,
  address,
  work_hours,
  timezone,
  is_active,
  metadata
)
select
  b.name,
  b.city,
  b.address,
  b.work_hours,
  b.timezone,
  coalesce(b.is_active, true),
  jsonb_build_object('legacy_branch_id', b.id)
from branches b
where b.marketplace_barbershop_id is null
  and not exists (
    select 1
    from marketplace_barbershops m
    where m.metadata ->> 'legacy_branch_id' = b.id::text
  );

update branches b
set marketplace_barbershop_id = m.id
from marketplace_barbershops m
where b.marketplace_barbershop_id is null
  and m.metadata ->> 'legacy_branch_id' = b.id::text;
