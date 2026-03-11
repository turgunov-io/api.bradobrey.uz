create table if not exists media_assets (
  id uuid default gen_random_uuid() primary key,
  type text check (type in ('kids', 'ads', 'music', 'video')) not null,
  title text,
  url text not null,
  mime_type text,
  duration_seconds integer,
  is_active boolean default true,
  barber_id uuid references barbers(id),
  created_at timestamp default now(),
  updated_at timestamp default now()
);

create index if not exists idx_media_assets_type_active on media_assets (type, is_active, created_at);

do $$
begin
  begin
    execute 'alter table media_assets drop constraint if exists media_assets_type_check';
  exception when undefined_object then null;
  end;

  alter table media_assets add constraint media_assets_type_check check (type in ('kids', 'ads', 'music', 'video'));

  if not exists (
    select 1
    from information_schema.columns
    where table_name = 'media_assets' and column_name = 'barber_id'
  ) then
    alter table media_assets add column barber_id uuid references barbers(id);
  end if;

  if not exists (
    select 1 from pg_indexes where tablename = 'media_assets' and indexname = 'idx_media_assets_barber'
  ) then
    create index idx_media_assets_barber on media_assets (barber_id, type, is_active, created_at);
  end if;
end $$;
