-- Rollback of 004_platform_owner_role.
-- Run manually in one transaction:  psql -v ON_ERROR_STOP=1 -1 -f <file>
-- platform_owner users must be removed or re-roled first, otherwise the
-- restored check fails. Also revert the role list in db/postgres/users.sql and
-- db/postgres/user_permissions.sql, or apply-schema.sh will put it back.

alter table users drop constraint if exists users_company_membership_check;
alter table users drop constraint if exists users_role_check;
alter table users
  add constraint users_role_check
  check (role in ('admin_network', 'admin_branch', 'admin', 'manager', 'merchant', 'barber', 'super-barber', 'super-manager'));
delete from schema_migrations where version = '004';
