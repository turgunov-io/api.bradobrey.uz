-- Multi-tenancy verification queries (read-only; temp table only).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/checks/multi_tenancy_checks.sql
--
-- Section A runs BEFORE `npm run migrate` (preflight for 001's barbershop
-- backfill). Sections B-D run after 001-004; every "problem_rows" must be 0.

-- A. Preflight: which barbershop is Bradobrey? 001 links the one with the most
--    branches (oldest wins a tie) unless MIGRATE_SEED_BARBERSHOP_ID is set.
--    Any other barbershop WITH branches makes 001 abort unless
--    MIGRATE_ALLOW_BARBERSHOP_SPLIT=on (its branches would move to a new company).
select mb.id, mb.name, mb.is_active, mb.created_at,
       count(b.id) as branch_count,
       (select count(*) from services s where s.marketplace_barbershop_id = mb.id) as services,
       (select count(*) from users u where u.marketplace_barbershop_id = mb.id) as users
  from marketplace_barbershops mb
  left join branches b on b.marketplace_barbershop_id = mb.id
 group by mb.id
 order by branch_count desc, mb.created_at;

select count(*) as branches_without_barbershop from branches where marketplace_barbershop_id is null;

-- B. Companies overview (after 001).
select c.code, c.name, c.status, c.is_default,
       mb.id as barbershop_id, mb.name as barbershop_name,
       (select count(*) from branches b where b.company_id = c.id) as branches,
       (select count(*) from users u where u.company_id = c.id) as users,
       (select count(*) from clients cl where cl.company_id = c.id) as clients
  from companies c
  left join marketplace_barbershops mb on mb.company_id = c.id
 order by c.is_default desc, c.created_at;

select count(*) filter (where is_default) as default_companies,
       (select count(*) from marketplace_barbershops where company_id is null) as unlinked_barbershops
  from companies;

-- C. NULL company_id and parent mismatches for every table carrying the
--    tenant_company_guard trigger. Parents are read from the trigger
--    arguments, so this stays in sync with migration 002.
create temp table if not exists mt_check_results (
  check_name text,
  table_name text,
  detail text,
  problem_rows bigint
);
truncate mt_check_results;

do $$
declare
  item record;
  arg text;
  parts text[];
  problems bigint;
begin
  for item in
    select c.relname as table_name,
           string_to_array(encode(t.tgargs, 'escape'), '\000') as args
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where t.tgname = 'tenant_company_guard' and n.nspname = 'public'
     order by c.relname
  loop
    if item.table_name = 'users' then
      execute 'select count(*) from public.users where company_id is null and role is distinct from ''platform_owner'''
        into problems;
    else
      execute format('select count(*) from public.%I where company_id is null', item.table_name) into problems;
    end if;
    insert into mt_check_results values ('null_company_id', item.table_name, null, problems);

    foreach arg in array item.args loop
      continue when arg = '' or arg like 'skip_if:%';
      parts := string_to_array(arg, ':');
      execute format(
        'select count(*) from public.%I t join public.%I p on p.%I = t.%I where p.company_id is not null and p.company_id <> t.company_id',
        item.table_name, parts[2], coalesce(parts[3], 'id'), parts[1]
      ) into problems;
      insert into mt_check_results values ('parent_company_mismatch', item.table_name, arg, problems);
    end loop;
  end loop;
end $$;

select * from mt_check_results where problem_rows > 0 order by check_name, table_name, detail;
select count(*) as checks_run, coalesce(sum(problem_rows), 0) as total_problem_rows from mt_check_results;

-- D. Targeted cross-company checks (prices must never mix).
select 'service_branch_vs_barbershop' as check_name, count(*) as problem_rows
  from services s
  join branches b on b.id = s.branch_id
  join marketplace_barbershops mb on mb.id = s.marketplace_barbershop_id
 where b.company_id <> mb.company_id
union all
select 'queue_service_ids_other_company', count(*)
  from queue_entries q
  cross join lateral unnest(coalesce(q.service_ids, '{}'::uuid[])) as sid
  join services s on s.id = sid
 where s.company_id <> q.company_id
union all
select 'employee_access_other_company', count(*)
  from employee_branch_access a
  join users u on u.id = a.employee_id
  join branches b on b.id = a.branch_id
 where u.company_id <> b.company_id
union all
select 'kiosk_other_company', count(*)
  from kiosks k join branches b on b.id = k.branch_id
 where k.company_id <> b.company_id
union all
select 'singleton_rows_without_company', count(*)
  from (
    select company_id from kiosk_ad_settings
    union all select company_id from client_rank_settings
    union all select company_id from verifix_settings
  ) s
 where s.company_id is null
union all
-- Must be 0 before 007_drop_global_uniques can be applied with code that relies on it.
select 'duplicate_login_within_company', count(*)
  from (select company_id, login from users group by 1, 2 having count(*) > 1) d;
