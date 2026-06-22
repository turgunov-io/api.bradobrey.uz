create table if not exists certificates (
  id uuid default gen_random_uuid() primary key,
  code text not null unique,
  service_ids uuid[] not null default '{}',
  expires_at timestamptz,
  is_used boolean not null default false,
  metadata jsonb,
  marketplace_barbershop_id uuid,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'certificates' and column_name = 'service_ids'
  ) then
    alter table certificates add column service_ids uuid[] not null default '{}';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'certificates' and column_name = 'is_used'
  ) then
    alter table certificates add column is_used boolean not null default false;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'certificates' and column_name = 'metadata'
  ) then
    alter table certificates add column metadata jsonb;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'certificates' and column_name = 'marketplace_barbershop_id'
  ) then
    alter table certificates add column marketplace_barbershop_id uuid;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'certificates' and column_name = 'created_at'
  ) then
    alter table certificates add column created_at timestamptz not null default now();
  end if;
end $$;

create index if not exists idx_certificates_used_expires
  on certificates (is_used, expires_at);

create index if not exists idx_certificates_marketplace_barbershop
  on certificates (marketplace_barbershop_id, is_used);
