-- Rollback of 008_company_kiosk_enrollment.
-- Run manually in one transaction:  psql -v ON_ERROR_STOP=1 -1 -f <file>
-- Deploy API code without per-company enrollment codes first (the new code
-- selects companies.kiosk_enrollment_code_hash).

alter table companies drop constraint if exists companies_kiosk_enrollment_code_hash_check;
alter table companies drop column if exists kiosk_enrollment_code_hash;

delete from schema_migrations where version = '008';
