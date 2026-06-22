create table if not exists barbers (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  photo_url text,
  branch_id uuid references branches(id),
  is_authorized boolean default false,
  is_on_shift boolean default false,
  is_active boolean default true,
  specialization text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'barbers' and column_name = 'phone'
  ) then
    alter table barbers add column phone text;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'barbers' and column_name = 'is_active'
  ) then
    alter table barbers add column is_active boolean default true;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'barbers' and column_name = 'created_at'
  ) then
    alter table barbers add column created_at timestamptz not null default now();
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'barbers' and column_name = 'updated_at'
  ) then
    alter table barbers add column updated_at timestamptz not null default now();
  end if;
end $$;
