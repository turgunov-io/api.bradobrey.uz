-- Phase 0.7: employee_branch_access becomes an ALLOW-list.
--
-- Before: listEmployeeBranches allowed EVERY active branch unless an
--         `is_active = false` row existed (deny-list).
-- After:  allowed = home branch (users.branch_id / barbers.branch_id)
--                   ∪ branches with an `is_active = true` row
--                   (network roles admin_network/admin/super-manager keep all),
--         and an `is_active = false` row still wins over everything.
--
-- This backfill grants explicit allow rows so that nobody loses a branch they
-- have actually been working in. Run it BEFORE deploying the API change.
-- It is idempotent (`on conflict do nothing`) and never touches existing rows,
-- so explicit deny rows (`is_active = false`) are preserved.
--
-- Evidence of real cross-branch work, last 90 days (window is deliberate:
-- long enough to cover rotations / vacation cover, short enough not to
-- resurrect one-off historical visits):
--   1. barber_activity_events  login / shift_start recorded for that branch
--      (written on every workspace login and branch switch — strongest signal)
--   2. queue_entries           clients actually served there
--      (status in_progress / completed)
--   3. employee_active_branches the branch the employee is in right now
--      (no window — an open session must keep working after deploy)
--   4. barber_work_schedules   an active current/future schedule there
--      (planned work that may not have happened yet)
-- Only active branches and existing users are granted (FK + no dead grants).

-- Optional dry run: list what would be inserted, without writing.
-- Replace the `insert ... select` below with `select * from candidates`.

with evidence as (
  select e.barber_id as employee_id, e.branch_id
    from barber_activity_events e
   where e.event_type in ('login', 'shift_start')
     and e.occurred_at >= now() - interval '90 days'
     and e.barber_id is not null
     and e.branch_id is not null
  union
  select q.barber_id, q.branch_id
    from queue_entries q
   where q.status in ('in_progress', 'completed')
     and q.created_at >= now() - interval '90 days'
     and q.barber_id is not null
     and q.branch_id is not null
  union
  select a.employee_id, a.branch_id
    from employee_active_branches a
  union
  select s.barber_id, s.branch_id
    from barber_work_schedules s
   where s.is_active = true
     and (s.valid_to is null or s.valid_to >= current_date)
     and s.barber_id is not null
     and s.branch_id is not null
),
candidates as (
  select distinct ev.employee_id, ev.branch_id
    from evidence ev
    join users u on u.id = ev.employee_id
    join branches b on b.id = ev.branch_id and b.is_active = true
)
insert into employee_branch_access (employee_id, branch_id, is_active)
select c.employee_id, c.branch_id, true
  from candidates c
on conflict (employee_id, branch_id) do nothing;

-- Home branches are allowed by code, but keep the legacy explicit row too
-- (same statement as employee_branches.sql; harmless if already present).
insert into employee_branch_access (employee_id, branch_id)
select u.id, u.branch_id
  from users u
 where u.branch_id is not null
on conflict (employee_id, branch_id) do nothing;
