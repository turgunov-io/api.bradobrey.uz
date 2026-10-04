-- Employee quality ranking v1. Additive and idempotent.
-- Apply after queue_entries.sql and queue_transfer_history.sql.

begin;

alter table if exists queue_entries
  add column if not exists quality_service_ids uuid[],
  add column if not exists quality_expected_duration_minutes numeric(12,4),
  add column if not exists quality_snapshot_at timestamptz;

create table if not exists queue_quality_assessments (
  id uuid primary key default gen_random_uuid(),
  -- Audit identifiers intentionally have no FK delete action. Deleting a live
  -- entity must not cascade or null immutable historical evidence.
  queue_entry_id uuid not null unique,
  employee_id uuid,
  branch_id uuid,
  employee_role text,
  completed_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  service_ids uuid[] not null default '{}',
  expected_duration_minutes numeric(12,4),
  actual_duration_minutes numeric(12,4),
  classifiable boolean not null,
  unclassified_reason text,
  suspicious boolean not null default false,
  rule_code text not null default 'duration-ratio',
  rule_version text not null default 'employee-quality-v1',
  assessment_source text not null,
  data_confidence text not null,
  review_state text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_comment text,
  review_version integer not null default 0 check (review_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint queue_quality_assessment_source_check
    check (assessment_source in ('live_snapshot', 'backfill_current_catalog')),
  constraint queue_quality_confidence_check
    check (data_confidence in ('authoritative', 'approximate')),
  constraint queue_quality_review_state_check
    check (review_state is null or review_state in ('unreviewed', 'confirmed', 'dismissed')),
  constraint queue_quality_classification_check
    check (
      (classifiable and unclassified_reason is null and expected_duration_minutes > 0 and actual_duration_minutes >= 0)
      or
      (not classifiable and unclassified_reason is not null and not suspicious)
    )
);

alter table if exists queue_quality_assessments
  add column if not exists employee_role text,
  add column if not exists review_version integer not null default 0;
alter table if exists queue_quality_assessments
  drop constraint if exists queue_quality_assessments_queue_entry_id_fkey,
  drop constraint if exists queue_quality_assessments_employee_id_fkey,
  drop constraint if exists queue_quality_assessments_branch_id_fkey,
  drop constraint if exists queue_quality_assessments_reviewed_by_fkey;

create index if not exists queue_quality_employee_completed_idx
  on queue_quality_assessments (employee_id, completed_at desc);
create index if not exists queue_quality_branch_completed_idx
  on queue_quality_assessments (branch_id, completed_at desc);
create index if not exists queue_quality_active_suspicious_idx
  on queue_quality_assessments (branch_id, employee_id, completed_at desc)
  where suspicious and review_state in ('unreviewed', 'confirmed');

create table if not exists queue_quality_review_events (
  id bigserial primary key,
  assessment_id uuid not null,
  queue_entry_id uuid not null,
  previous_state text,
  review_state text not null check (review_state in ('confirmed', 'dismissed')),
  reviewer_id uuid not null,
  review_comment text not null,
  idempotency_key text not null unique,
  expected_version integer not null check (expected_version >= 0),
  resulting_version integer not null check (resulting_version > expected_version),
  reviewer_scope_type text not null check (reviewer_scope_type in ('branch', 'global')),
  reviewer_branch_id uuid,
  occurred_at timestamptz not null default now()
);

alter table if exists queue_quality_review_events
  add column if not exists idempotency_key text,
  add column if not exists expected_version integer,
  add column if not exists resulting_version integer,
  add column if not exists reviewer_scope_type text,
  add column if not exists reviewer_branch_id uuid;
alter table if exists queue_quality_review_events
  drop constraint if exists queue_quality_review_events_assessment_id_fkey,
  drop constraint if exists queue_quality_review_events_queue_entry_id_fkey,
  drop constraint if exists queue_quality_review_events_reviewer_id_fkey,
  drop constraint if exists queue_quality_review_events_reviewer_branch_id_fkey;
create unique index if not exists queue_quality_review_idempotency_uq
  on queue_quality_review_events (idempotency_key)
  where idempotency_key is not null;

create index if not exists queue_quality_review_assessment_idx
  on queue_quality_review_events (assessment_id, occurred_at desc, id desc);

alter table if exists queue_status_events
  add column if not exists branch_id uuid,
  add column if not exists actor_id uuid,
  add column if not exists actor_role text,
  add column if not exists actor_type text not null default 'unknown',
  add column if not exists responsible_employee_id uuid,
  add column if not exists reason_code text;
alter table if exists queue_status_events
  drop constraint if exists queue_status_events_queue_entry_id_fkey,
  drop constraint if exists queue_status_events_branch_id_fkey,
  drop constraint if exists queue_status_events_actor_id_fkey,
  drop constraint if exists queue_status_events_responsible_employee_id_fkey;

alter table if exists queue_status_events
  drop constraint if exists queue_status_events_actor_type_check;
alter table if exists queue_status_events
  add constraint queue_status_events_actor_type_check
  check (actor_type in ('employee', 'customer', 'manager', 'system', 'unknown'));

alter table if exists queue_status_events
  drop constraint if exists queue_status_events_reason_code_check;
-- Normalize rows from any pre-release draft of this migration before applying
-- the final v1 controlled vocabulary. Historical generic rows remain neutral.
update queue_status_events
   set actor_id = null,
       actor_role = null,
       actor_type = 'unknown',
       responsible_employee_id = null,
       reason_code = 'unknown'
 where reason_code is not null
   and reason_code not in (
     'employee_refused', 'employee_unavailable', 'employee_schedule_conflict',
     'employee_cancelled_after_start', 'client_requested_cancel', 'client_no_show',
     'client_late', 'manager_override', 'system_timeout',
     'duplicate_or_invalid_booking', 'unknown'
   );
alter table if exists queue_status_events
  add constraint queue_status_events_reason_code_check
  check (reason_code is null or reason_code in (
    'employee_refused', 'employee_unavailable', 'employee_schedule_conflict',
    'employee_cancelled_after_start', 'client_requested_cancel', 'client_no_show',
    'client_late', 'manager_override', 'system_timeout',
    'duplicate_or_invalid_booking', 'unknown'
  ));

alter table if exists queue_status_events
  drop constraint if exists queue_status_events_employee_attribution_check;
alter table if exists queue_status_events
  add constraint queue_status_events_employee_attribution_check
  check (
    (actor_type = 'employee'
      and responsible_employee_id is not null
      and reason_code in (
        'employee_refused', 'employee_unavailable', 'employee_schedule_conflict',
        'employee_cancelled_after_start'
      ))
    or
    (actor_type <> 'employee' and responsible_employee_id is null)
  );

alter table if exists queue_status_events
  drop constraint if exists queue_status_events_actor_reason_check;
alter table if exists queue_status_events
  add constraint queue_status_events_actor_reason_check
  check (
    (actor_type = 'employee' and reason_code in (
      'employee_refused', 'employee_unavailable', 'employee_schedule_conflict',
      'employee_cancelled_after_start'
    ))
    or (actor_type = 'customer' and reason_code in (
      'client_requested_cancel', 'client_no_show', 'client_late'
    ))
    or (actor_type = 'manager' and reason_code = 'manager_override')
    or (actor_type = 'system' and reason_code in ('system_timeout', 'duplicate_or_invalid_booking'))
    or (actor_type = 'unknown' and (reason_code is null or reason_code = 'unknown'))
  ) not valid;

create index if not exists queue_status_events_quality_idx
  on queue_status_events (branch_id, responsible_employee_id, occurred_at desc, to_status);
create index if not exists queue_status_events_branch_occurred_idx
  on queue_status_events (branch_id, occurred_at desc, to_status);
create index if not exists queue_status_events_employee_occurred_idx
  on queue_status_events (responsible_employee_id, occurred_at desc, to_status)
  where responsible_employee_id is not null;
create index if not exists queue_status_events_global_occurred_idx
  on queue_status_events (occurred_at desc, to_status);

-- Immutable versions of the service-duration evidence used by completion.
-- Actor fields remain null until status-changing routes are migrated to the
-- attributed transaction helper; unknown attribution is safer than inference.
create table if not exists queue_quality_plan_snapshots (
  id bigserial primary key,
  queue_entry_id uuid not null,
  version integer not null check (version > 0),
  service_ids uuid[] not null default '{}',
  expected_duration_minutes numeric(12,4),
  actor_id uuid,
  actor_role text,
  reason_code text not null check (reason_code in ('work_started', 'service_composition_changed')),
  occurred_at timestamptz not null default now(),
  unique (queue_entry_id, version)
);
alter table if exists queue_quality_plan_snapshots
  drop constraint if exists queue_quality_plan_snapshots_queue_entry_id_fkey,
  drop constraint if exists queue_quality_plan_snapshots_actor_id_fkey;
create index if not exists queue_quality_plan_snapshot_latest_idx
  on queue_quality_plan_snapshots (queue_entry_id, version desc);

-- Audit event tables are append-only. Assessment review projection fields may
-- change, but classification evidence and raw identifiers may not.
create or replace function reject_quality_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '55000';
end;
$$;

drop trigger if exists queue_quality_plan_snapshots_append_only on queue_quality_plan_snapshots;
create trigger queue_quality_plan_snapshots_append_only
  before update or delete on queue_quality_plan_snapshots
  for each row execute function reject_quality_audit_mutation();

drop trigger if exists queue_quality_review_events_append_only on queue_quality_review_events;
create trigger queue_quality_review_events_append_only
  before update or delete on queue_quality_review_events
  for each row execute function reject_quality_audit_mutation();

drop trigger if exists queue_status_events_append_only on queue_status_events;
create trigger queue_status_events_append_only
  before update or delete on queue_status_events
  for each row execute function reject_quality_audit_mutation();

create or replace function protect_queue_quality_assessment_evidence()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'queue_quality_assessments cannot be deleted' using errcode = '55000';
  end if;
  if new.id is distinct from old.id
    or new.created_at is distinct from old.created_at
    or new.queue_entry_id is distinct from old.queue_entry_id
    or new.employee_id is distinct from old.employee_id
    or new.branch_id is distinct from old.branch_id
    or new.employee_role is distinct from old.employee_role
    or new.completed_at is distinct from old.completed_at
    or new.started_at is distinct from old.started_at
    or new.finished_at is distinct from old.finished_at
    or new.service_ids is distinct from old.service_ids
    or new.expected_duration_minutes is distinct from old.expected_duration_minutes
    or new.actual_duration_minutes is distinct from old.actual_duration_minutes
    or new.classifiable is distinct from old.classifiable
    or new.unclassified_reason is distinct from old.unclassified_reason
    or new.suspicious is distinct from old.suspicious
    or new.rule_code is distinct from old.rule_code
    or new.rule_version is distinct from old.rule_version
    or new.assessment_source is distinct from old.assessment_source
    or new.data_confidence is distinct from old.data_confidence then
    raise exception 'queue_quality_assessment evidence is immutable' using errcode = '55000';
  end if;
  if new.review_state is distinct from old.review_state
    or new.reviewed_by is distinct from old.reviewed_by
    or new.reviewed_at is distinct from old.reviewed_at
    or new.review_comment is distinct from old.review_comment
    or new.review_version is distinct from old.review_version then
    if new.review_version <> old.review_version + 1
      or new.review_state not in ('confirmed', 'dismissed')
      or new.reviewed_by is null
      or new.reviewed_at is null
      or nullif(btrim(new.review_comment), '') is null
      or not exists (
        select 1
          from queue_quality_review_events event
         where event.assessment_id = old.id
           and event.queue_entry_id = old.queue_entry_id
           and event.reviewer_id = new.reviewed_by
           and event.review_state = new.review_state
           and event.review_comment = new.review_comment
           and event.expected_version = old.review_version
           and event.resulting_version = new.review_version
      ) then
      raise exception 'quality review projection requires a matching constrained review event' using errcode = '55000';
    end if;
  elsif new.updated_at is distinct from old.updated_at then
    raise exception 'queue_quality_assessment update is not permitted' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists queue_quality_assessments_evidence_immutable on queue_quality_assessments;
create trigger queue_quality_assessments_evidence_immutable
  before update or delete on queue_quality_assessments
  for each row execute function protect_queue_quality_assessment_evidence();

-- Keep the employee directory row required to render and explain historical
-- rankings. Application deletion paths archive employees; hard deletion is
-- rejected once immutable quality evidence exists.
create or replace function protect_employee_with_quality_audit()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from queue_quality_assessments assessment
     where assessment.employee_id = old.id
  ) then
    raise exception 'employee % has immutable quality audit; archive instead', old.id
      using errcode = '55000';
  end if;
  return old;
end;
$$;

drop trigger if exists barbers_quality_audit_delete_guard on barbers;
create trigger barbers_quality_audit_delete_guard
  before delete on barbers
  for each row execute function protect_employee_with_quality_audit();

create index if not exists payments_queue_entry_id_idx
  on payments (queue_entry_id);

-- Snapshot the selected services at start and whenever an in-progress order is
-- explicitly edited. This prevents later catalogue edits from rewriting the
-- evidence while still supporting the existing in-progress service-edit flow.
create or replace function snapshot_queue_quality_plan()
returns trigger language plpgsql as $$
declare
  snapshot_ids uuid[];
  expected_minutes numeric(12,4);
begin
  -- Terminal evidence uses database time. Client-provided timestamps cannot
  -- make a completion appear faster or move it into another reporting period.
  if new.status = 'in_progress' and old.status is distinct from 'in_progress' then
    new.started_at := now();
  end if;
  if new.status = 'completed' and old.status is distinct from 'completed' then
    new.finished_at := now();
  end if;

  if new.status = 'in_progress' and (
    old.status is distinct from new.status
    or old.service_id is distinct from new.service_id
    or old.service_ids is distinct from new.service_ids
  ) then
    snapshot_ids := case
      when coalesce(array_length(new.service_ids, 1), 0) > 0 then new.service_ids
      when new.service_id is not null then array[new.service_id]
      else '{}'::uuid[]
    end;
    select coalesce(sum(s.duration_minutes), 0)::numeric(12,4)
      into expected_minutes
      from services s
     where s.id = any(snapshot_ids);
    new.quality_service_ids := snapshot_ids;
    new.quality_expected_duration_minutes := nullif(expected_minutes, 0);
    new.quality_snapshot_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists queue_entries_quality_plan_snapshot on queue_entries;
create trigger queue_entries_quality_plan_snapshot
  before update of status, service_id, service_ids on queue_entries
  for each row execute function snapshot_queue_quality_plan();

create or replace function record_queue_quality_plan_snapshot()
returns trigger language plpgsql as $$
declare
  next_version integer;
begin
  if new.quality_snapshot_at is distinct from old.quality_snapshot_at then
    select coalesce(max(version), 0) + 1 into next_version
      from queue_quality_plan_snapshots
     where queue_entry_id = new.id;
    insert into queue_quality_plan_snapshots (
      queue_entry_id, version, service_ids, expected_duration_minutes, reason_code, occurred_at
    ) values (
      new.id, next_version, coalesce(new.quality_service_ids, '{}'::uuid[]),
      new.quality_expected_duration_minutes,
      case when old.status is distinct from 'in_progress' then 'work_started'
           else 'service_composition_changed' end,
      new.quality_snapshot_at
    );
  end if;
  return new;
end;
$$;

drop trigger if exists queue_entries_quality_plan_snapshot_event on queue_entries;
create trigger queue_entries_quality_plan_snapshot_event
  after update of status, service_id, service_ids on queue_entries
  for each row execute function record_queue_quality_plan_snapshot();

-- The transition trigger captures classification in the same database
-- transaction as completion. It is insert-only: retries cannot rewrite it.
create or replace function capture_queue_quality_assessment()
returns trigger language plpgsql as $$
declare
  expected_minutes numeric(12,4);
  actual_minutes numeric(12,4);
  can_classify boolean;
  reason text;
  is_suspicious boolean;
  snapshot_service_ids uuid[];
  snapshot_employee_role text;
begin
  if new.status is distinct from 'completed'
    or old.status is not distinct from 'completed' then
    return new;
  end if;

  snapshot_service_ids := case
    when coalesce(array_length(new.quality_service_ids, 1), 0) > 0 then new.quality_service_ids
    when coalesce(array_length(new.service_ids, 1), 0) > 0 then new.service_ids
    when new.service_id is not null then array[new.service_id]
    else '{}'::uuid[]
  end;

  expected_minutes := new.quality_expected_duration_minutes;
  if expected_minutes is null then
    select coalesce(sum(s.duration_minutes), 0)::numeric(12,4)
      into expected_minutes
      from services s
     where s.id = any(snapshot_service_ids);
  end if;
  select u.role into snapshot_employee_role from users u where u.id = new.barber_id;

  actual_minutes := case
    when new.started_at is not null and new.finished_at is not null
      then extract(epoch from (new.finished_at - new.started_at)) / 60.0
    else null
  end;

  reason := case
    when new.barber_id is null then 'missing_employee'
    when expected_minutes <= 0 then 'missing_expected_duration'
    when new.started_at is null then 'missing_started_at'
    when new.finished_at is null then 'missing_finished_at'
    when new.finished_at < new.started_at then 'finished_before_started'
    else null
  end;
  can_classify := reason is null;
  is_suspicious := can_classify and actual_minutes < expected_minutes * 0.50;

  insert into queue_quality_assessments (
    queue_entry_id, employee_id, branch_id, employee_role, completed_at, started_at, finished_at,
    service_ids, expected_duration_minutes, actual_duration_minutes,
    classifiable, unclassified_reason, suspicious, rule_code, rule_version,
    assessment_source, data_confidence, review_state
  ) values (
    new.id, new.barber_id, new.branch_id, snapshot_employee_role, coalesce(new.finished_at, now()), new.started_at, new.finished_at,
    snapshot_service_ids, nullif(expected_minutes, 0), case when can_classify then actual_minutes else null end,
    can_classify, reason, is_suspicious, 'duration-ratio', 'employee-quality-v1',
    'live_snapshot',
    case when new.quality_snapshot_at is not null then 'authoritative' else 'approximate' end,
    case when is_suspicious then 'unreviewed' else null end
  ) on conflict (queue_entry_id) do nothing;

  return new;
end;
$$;

drop trigger if exists queue_entries_quality_assessment on queue_entries;
create trigger queue_entries_quality_assessment
  after update of status on queue_entries
  for each row execute function capture_queue_quality_assessment();

-- Preserve branch snapshots on future status events. Actor/responsibility stays
-- unknown unless the application writes an explicit attributed audit event.
create or replace function record_queue_status_event() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into queue_status_events(queue_entry_id, branch_id, from_status, to_status, barber_id)
    values (new.id, new.branch_id, null, new.status, new.barber_id);
  elsif old.status is distinct from new.status or old.barber_id is distinct from new.barber_id then
    insert into queue_status_events(queue_entry_id, branch_id, from_status, to_status, barber_id)
    values (new.id, new.branch_id, old.status, new.status, new.barber_id);
  end if;
  return new;
end;
$$;

-- Legacy completion evidence is explicitly approximate and never eligible for
-- an official v1 rank. This backfill is idempotent and does not infer actor or
-- cancellation responsibility.
insert into queue_quality_assessments (
  queue_entry_id, employee_id, branch_id, employee_role, completed_at, started_at, finished_at,
  service_ids, expected_duration_minutes, actual_duration_minutes,
  classifiable, unclassified_reason, suspicious, rule_code, rule_version,
  assessment_source, data_confidence, review_state
)
select
  q.id,
  q.barber_id,
  q.branch_id,
  u.role,
  q.finished_at,
  q.started_at,
  q.finished_at,
  service_snapshot.ids,
  nullif(service_snapshot.expected_minutes, 0),
  case when quality.reason is null then quality.actual_minutes else null end,
  quality.reason is null,
  quality.reason,
  quality.reason is null and quality.actual_minutes < service_snapshot.expected_minutes * 0.50,
  'duration-ratio',
  'employee-quality-v1',
  'backfill_current_catalog',
  'approximate',
  case
    when quality.reason is null and quality.actual_minutes < service_snapshot.expected_minutes * 0.50 then 'unreviewed'
    else null
  end
from queue_entries q
left join users u on u.id = q.barber_id
cross join lateral (
  select
    case
      when coalesce(array_length(q.service_ids, 1), 0) > 0 then q.service_ids
      when q.service_id is not null then array[q.service_id]
      else '{}'::uuid[]
    end as ids,
    coalesce((
      select sum(s.duration_minutes)::numeric(12,4)
      from services s
      where s.id = any(case
        when coalesce(array_length(q.service_ids, 1), 0) > 0 then q.service_ids
        when q.service_id is not null then array[q.service_id]
        else '{}'::uuid[]
      end)
    ), 0)::numeric(12,4) as expected_minutes
) service_snapshot
cross join lateral (
  select
    case
      when q.started_at is not null and q.finished_at is not null
        then extract(epoch from (q.finished_at - q.started_at)) / 60.0
      else null
    end::numeric(12,4) as actual_minutes,
    case
      when q.barber_id is null then 'missing_employee'
      when service_snapshot.expected_minutes <= 0 then 'missing_expected_duration'
      when q.started_at is null then 'missing_started_at'
      when q.finished_at is null then 'missing_finished_at'
      when q.finished_at < q.started_at then 'finished_before_started'
      else null
    end as reason
) quality
where q.status = 'completed'
  and q.finished_at is not null
on conflict (queue_entry_id) do nothing;

-- Permissions are deliberately not inferred from role names. Existing and new
-- users retain their authoritative explicit user_permissions set, including an
-- intentionally empty set. Remove pre-release auto-grant machinery if present.
drop trigger if exists users_seed_employee_quality_permissions on users;
drop function if exists seed_employee_quality_permissions();

commit;
