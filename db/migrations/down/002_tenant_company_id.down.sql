-- Rollback of 002_tenant_company_id. Run the 004 and 003 downs first.
-- Run manually in one transaction:  psql -v ON_ERROR_STOP=1 -1 -f <file>
-- Drops company_id (with its FK, indexes and guard trigger) from every table
-- that carries the tenant_company_guard trigger. Data loss: the company
-- assignment of each row (all rows are company #1 unless a barbershop split ran).

do $$
declare
  item record;
begin
  for item in
    select c.relname
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where t.tgname = 'tenant_company_guard' and n.nspname = 'public'
  loop
    execute format('drop trigger if exists tenant_company_guard on public.%I', item.relname);
    execute format('alter table public.%I drop column if exists company_id cascade', item.relname);
  end loop;
end $$;

drop index if exists idx_queue_entries_company_created;
drop index if exists idx_users_company_role;
drop index if exists idx_services_company_active;
drop index if exists idx_cashback_transactions_company_created;
drop index if exists idx_barber_activity_events_company_time;

drop function if exists public.tenant_assign_company_id();
drop function if exists public.tenant_default_company_id();
delete from schema_migrations where version = '002';
