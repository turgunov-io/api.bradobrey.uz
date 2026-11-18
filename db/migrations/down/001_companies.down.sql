-- Rollback of 001_companies. Run the 004, 003, 002 downs first (they depend on it).
-- Run manually in one transaction:  psql -v ON_ERROR_STOP=1 -1 -f <file>
-- Data loss: company rows (names/codes/branding) and the barbershop links.

alter table if exists marketplace_barbershops drop column if exists company_id;
drop table if exists companies;
drop function if exists public.set_companies_updated_at();
delete from schema_migrations where version = '001';
