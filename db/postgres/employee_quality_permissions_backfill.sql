begin;

-- One-time rollout provisioning for users that existed before the
-- employee-quality permissions were introduced. The marker is important:
-- re-running apply-schema must not restore a permission that an administrator
-- deliberately revoked later.
create table if not exists schema_data_migrations (
  migration_key text primary key,
  applied_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
      from schema_data_migrations
     where migration_key = 'employee_quality_permissions_v1_backfill'
  ) then
    insert into user_permissions (user_id, permission)
    select id, permission
      from (
        select id, unnest(array[
          'dashboard.access',
          'history.read.branch',
          'statistics.read.branch',
          'statistics.read.global',
          'statistics.quality.review'
        ]) as permission
          from users
         where role in ('admin_network', 'admin', 'super-manager')

        union all

        select id, unnest(array[
          'dashboard.access',
          'history.read.branch',
          'statistics.read.branch',
          'statistics.quality.review'
        ]) as permission
          from users
         where role in ('admin_branch', 'manager')

        union all

        select id, unnest(array[
          'history.read.self',
          'statistics.read.self'
        ]) as permission
          from users
         where role in ('barber', 'super-barber')
      ) grants
    on conflict (user_id, permission) do nothing;

    insert into schema_data_migrations (migration_key)
    values ('employee_quality_permissions_v1_backfill');
  end if;
end
$$;

commit;
