create table if not exists barbers (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  photo_url text,
  branch_id uuid references branches(id),
  is_authorized boolean default false,
  is_on_shift boolean default false,
  specialization text,
  phone text
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
end $$;
