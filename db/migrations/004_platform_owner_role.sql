-- 004_platform_owner_role — platform owner (owner decision 2026-11-18).
--
-- The platform owner manages companies (create, admins, enable/disable) and
-- does NOT belong to any company, so it is the only role with
-- users.company_id NULL; every other user must belong to a company.
-- No data access is granted anywhere yet (Phase 1 step B wires the role).
--
-- db/postgres/users.sql and user_permissions.sql were updated with the same
-- role list, so re-running scripts/apply-schema.sh keeps platform_owner valid.
--
-- Rollback: db/migrations/down/004_platform_owner_role.down.sql

alter table users drop constraint if exists users_role_check;
alter table users
  add constraint users_role_check
  check (role in (
    'platform_owner',
    'admin_network', 'admin_branch', 'admin', 'manager', 'merchant',
    'barber', 'super-barber', 'super-manager'
  ));

alter table users drop constraint if exists users_company_membership_check;
alter table users
  add constraint users_company_membership_check
  check ((role is not distinct from 'platform_owner') = (company_id is null));
