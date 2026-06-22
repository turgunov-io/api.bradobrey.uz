create table if not exists barber_work_schedules (
  id uuid default gen_random_uuid() primary key,
  branch_id uuid references branches(id) on delete cascade,
  barber_id uuid references barbers(id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time,
  grace_minutes integer not null default 0 check (grace_minutes >= 0),
  is_active boolean not null default true,
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table barber_work_schedules
  add column if not exists branch_id uuid references branches(id) on delete cascade,
  add column if not exists barber_id uuid references barbers(id) on delete cascade,
  add column if not exists day_of_week integer,
  add column if not exists start_time time,
  add column if not exists end_time time,
  add column if not exists grace_minutes integer not null default 0,
  add column if not exists is_active boolean not null default true,
  add column if not exists valid_from date,
  add column if not exists valid_to date,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update barber_work_schedules set grace_minutes = 0 where grace_minutes is null;
update barber_work_schedules set is_active = true where is_active is null;

alter table barber_work_schedules
  alter column grace_minutes set default 0,
  alter column grace_minutes set not null,
  alter column is_active set default true,
  alter column is_active set not null,
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

alter table barber_work_schedules
  drop constraint if exists barber_work_schedules_day_of_week_check,
  drop constraint if exists barber_work_schedules_grace_minutes_check;

alter table barber_work_schedules
  add constraint barber_work_schedules_day_of_week_check check (day_of_week between 0 and 6),
  add constraint barber_work_schedules_grace_minutes_check check (grace_minutes >= 0);

create index if not exists idx_barber_work_schedules_branch_day
  on barber_work_schedules (branch_id, day_of_week, is_active);

create index if not exists idx_barber_work_schedules_barber_day
  on barber_work_schedules (barber_id, day_of_week, is_active);

create table if not exists barber_activity_events (
  id uuid default gen_random_uuid() primary key,
  branch_id uuid references branches(id) on delete set null,
  barber_id uuid references barbers(id) on delete set null,
  actor_id uuid references users(id) on delete set null,
  actor_role text,
  event_type text not null check (
    event_type in (
      'login',
      'logout',
      'shift_start',
      'shift_end',
      'break_start',
      'break_end',
      'manual_adjustment'
    )
  ),
  source text not null default 'barber_kiosk' check (
    source in ('barber_kiosk', 'dashboard', 'system')
  ),
  occurred_at timestamptz not null default now(),
  schedule_id uuid references barber_work_schedules(id) on delete set null,
  scheduled_start_at timestamptz,
  grace_minutes integer not null default 0 check (grace_minutes >= 0),
  is_late boolean not null default false,
  late_by_minutes integer not null default 0 check (late_by_minutes >= 0),
  penalty_amount numeric(12,2) not null default 0 check (penalty_amount >= 0),
  penalty_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table barber_activity_events
  add column if not exists branch_id uuid references branches(id) on delete set null,
  add column if not exists barber_id uuid references barbers(id) on delete set null,
  add column if not exists actor_id uuid references users(id) on delete set null,
  add column if not exists actor_role text,
  add column if not exists event_type text,
  add column if not exists source text not null default 'barber_kiosk',
  add column if not exists occurred_at timestamptz not null default now(),
  add column if not exists schedule_id uuid references barber_work_schedules(id) on delete set null,
  add column if not exists scheduled_start_at timestamptz,
  add column if not exists grace_minutes integer not null default 0,
  add column if not exists is_late boolean not null default false,
  add column if not exists late_by_minutes integer not null default 0,
  add column if not exists penalty_amount numeric(12,2) not null default 0,
  add column if not exists penalty_reason text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

update barber_activity_events set source = 'barber_kiosk' where source is null;
update barber_activity_events set occurred_at = now() where occurred_at is null;
update barber_activity_events set grace_minutes = 0 where grace_minutes is null;
update barber_activity_events set is_late = false where is_late is null;
update barber_activity_events set late_by_minutes = 0 where late_by_minutes is null;
update barber_activity_events set penalty_amount = 0 where penalty_amount is null;
update barber_activity_events set metadata = '{}'::jsonb where metadata is null;
update barber_activity_events set created_at = now() where created_at is null;

alter table barber_activity_events
  alter column source set default 'barber_kiosk',
  alter column source set not null,
  alter column occurred_at set default now(),
  alter column occurred_at set not null,
  alter column grace_minutes set default 0,
  alter column grace_minutes set not null,
  alter column is_late set default false,
  alter column is_late set not null,
  alter column late_by_minutes set default 0,
  alter column late_by_minutes set not null,
  alter column penalty_amount set default 0,
  alter column penalty_amount set not null,
  alter column metadata set default '{}'::jsonb,
  alter column metadata set not null,
  alter column created_at set default now(),
  alter column created_at set not null;

alter table barber_activity_events
  drop constraint if exists barber_activity_events_event_type_check,
  drop constraint if exists barber_activity_events_source_check,
  drop constraint if exists barber_activity_events_grace_minutes_check,
  drop constraint if exists barber_activity_events_late_by_minutes_check,
  drop constraint if exists barber_activity_events_penalty_amount_check;

alter table barber_activity_events
  add constraint barber_activity_events_event_type_check check (
    event_type in (
      'login',
      'logout',
      'shift_start',
      'shift_end',
      'break_start',
      'break_end',
      'manual_adjustment'
    )
  ),
  add constraint barber_activity_events_source_check check (
    source in ('barber_kiosk', 'dashboard', 'system')
  ),
  add constraint barber_activity_events_grace_minutes_check check (grace_minutes >= 0),
  add constraint barber_activity_events_late_by_minutes_check check (late_by_minutes >= 0),
  add constraint barber_activity_events_penalty_amount_check check (penalty_amount >= 0);

create index if not exists idx_barber_activity_events_branch_time
  on barber_activity_events (branch_id, occurred_at desc);

create index if not exists idx_barber_activity_events_barber_time
  on barber_activity_events (barber_id, occurred_at desc);

create index if not exists idx_barber_activity_events_late
  on barber_activity_events (is_late, occurred_at desc);

create index if not exists idx_barber_activity_events_type
  on barber_activity_events (event_type, occurred_at desc);
