do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'queue_entries'
      and column_name = 'created_at'
      and data_type = 'timestamp without time zone'
  ) then
    alter table queue_entries
      alter column created_at type timestamptz using created_at at time zone 'UTC';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'queue_entries'
      and column_name = 'started_at'
      and data_type = 'timestamp without time zone'
  ) then
    alter table queue_entries
      alter column started_at type timestamptz using started_at at time zone 'UTC';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'queue_entries'
      and column_name = 'finished_at'
      and data_type = 'timestamp without time zone'
  ) then
    alter table queue_entries
      alter column finished_at type timestamptz using finished_at at time zone 'UTC';
  end if;

  alter table queue_entries
    alter column created_at set default now();
end $$;
