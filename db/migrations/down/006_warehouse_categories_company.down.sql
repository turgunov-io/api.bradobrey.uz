-- Rollback of 006_warehouse_categories_company.
-- Run manually in one transaction:  psql -v ON_ERROR_STOP=1 -1 -f <file>
-- Leaves company_id, its FK and the guard trigger in place (002's down file
-- removes those for every tenant table); only drops what 006 alone adds.

drop index if exists idx_warehouse_categories_company;

delete from schema_migrations where version = '006';
