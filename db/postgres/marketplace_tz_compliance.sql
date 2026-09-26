-- BRADOBREY marketplace compliance foundation.
-- Apply after the existing marketplace, clients, queue and cashback migrations.
-- This migration is intentionally additive and safe to run repeatedly.

create table if not exists platform_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  description text,
  updated_at timestamptz not null default now()
);

create table if not exists marketplace_bookings (
  id uuid default gen_random_uuid() primary key,
  marketplace_client_id uuid not null references marketplace_clients(id) on delete restrict,
  source text not null default 'MARKETPLACE' check (source in ('MARKETPLACE', 'KIOSK')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),
  request_id text,
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  cancel_count integer not null default 0 check (cancel_count >= 0),
  cancelled_at timestamptz,
  cooldown_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists marketplace_bookings_active_client_uidx
  on marketplace_bookings (marketplace_client_id)
  where status = 'ACTIVE';

create unique index if not exists marketplace_bookings_request_uidx
  on marketplace_bookings (request_id)
  where request_id is not null;

create index if not exists marketplace_bookings_client_created_idx
  on marketplace_bookings (marketplace_client_id, created_at desc);

create table if not exists marketplace_booking_persons (
  id uuid default gen_random_uuid() primary key,
  booking_id uuid not null references marketplace_bookings(id) on delete cascade,
  person_index smallint not null check (person_index between 1 and 4),
  display_name text not null,
  barber_id uuid references barbers(id) on delete restrict,
  queue_entry_id uuid references queue_entries(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (booking_id, person_index)
);

create table if not exists marketplace_booking_person_services (
  person_id uuid not null references marketplace_booking_persons(id) on delete cascade,
  service_id uuid not null references services(id) on delete restrict,
  price numeric(12,2) not null default 0 check (price >= 0),
  duration_minutes integer not null default 0 check (duration_minutes >= 0),
  primary key (person_id, service_id)
);

-- Keeps the first/last marketplace interaction of a client with each
-- barbershop without duplicating the global client account.
create table if not exists client_barbershop_origins (
  marketplace_client_id uuid not null references marketplace_clients(id) on delete cascade,
  barbershop_id uuid not null references marketplace_barbershops(id) on delete cascade,
  first_booking_at timestamptz not null default now(),
  last_booking_at timestamptz not null default now(),
  booking_count integer not null default 1 check (booking_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (marketplace_client_id, barbershop_id)
);

create index if not exists client_barbershop_origins_barbershop_idx
  on client_barbershop_origins (barbershop_id, last_booking_at desc);

create index if not exists marketplace_booking_persons_booking_idx
  on marketplace_booking_persons (booking_id);

create table if not exists status_point_transactions (
  id uuid default gen_random_uuid() primary key,
  marketplace_client_id uuid not null references marketplace_clients(id) on delete restrict,
  booking_id uuid references marketplace_bookings(id) on delete set null,
  kind text not null check (kind in ('EARN', 'PENALTY', 'ADJUSTMENT')),
  amount integer not null check (amount <> 0),
  reason text not null,
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table status_point_transactions add column if not exists queue_entry_id uuid references queue_entries(id) on delete set null;

create unique index if not exists status_point_queue_kind_uidx
  on status_point_transactions (queue_entry_id, kind)
  where queue_entry_id is not null;

create unique index if not exists status_point_booking_kind_uidx
  on status_point_transactions (booking_id, kind)
  where booking_id is not null;

create unique index if not exists status_point_request_uidx
  on status_point_transactions (request_id)
  where request_id is not null;

create index if not exists status_point_client_created_idx
  on status_point_transactions (marketplace_client_id, created_at desc);

create table if not exists referral_accounts (
  marketplace_client_id uuid primary key references marketplace_clients(id) on delete cascade,
  referral_code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists referrals (
  id uuid default gen_random_uuid() primary key,
  referrer_client_id uuid not null references marketplace_clients(id) on delete restrict,
  referred_client_id uuid not null unique references marketplace_clients(id) on delete restrict,
  referral_code text not null references referral_accounts(referral_code) on delete restrict,
  expires_at timestamptz not null,
  activated_at timestamptz,
  source_ip inet,
  device_id text,
  created_at timestamptz not null default now(),
  check (referrer_client_id <> referred_client_id)
);

alter table referrals add column if not exists source_ip inet;
alter table referrals add column if not exists device_id text;

create table if not exists referral_transactions (
  id uuid default gen_random_uuid() primary key,
  referral_id uuid not null references referrals(id) on delete restrict,
  booking_id uuid references marketplace_bookings(id) on delete set null,
  amount numeric(12,2) not null check (amount > 0),
  paid_with_money numeric(12,2) not null check (paid_with_money >= 0),
  created_at timestamptz not null default now(),
  unique (referral_id, booking_id)
);

create table if not exists marketplace_reviews (
  id uuid default gen_random_uuid() primary key,
  marketplace_client_id uuid not null references marketplace_clients(id) on delete restrict,
  booking_id uuid not null unique references marketplace_bookings(id) on delete restrict,
  barbershop_id uuid references marketplace_barbershops(id) on delete set null,
  rating smallint not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists marketplace_audit_logs (
  id uuid default gen_random_uuid() primary key,
  marketplace_client_id uuid references marketplace_clients(id) on delete set null,
  action text not null,
  request_id text,
  entity_type text,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists marketplace_audit_logs_created_idx
  on marketplace_audit_logs (created_at desc);

create table if not exists marketplace_fraud_alerts (
  id uuid default gen_random_uuid() primary key,
  marketplace_client_id uuid references marketplace_clients(id) on delete set null,
  kind text not null,
  source_ip inet,
  device_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists marketplace_fraud_alerts_created_idx
  on marketplace_fraud_alerts (created_at desc);

alter table marketplace_fraud_alerts add column if not exists status text not null default 'OPEN';
alter table marketplace_fraud_alerts add column if not exists reviewed_at timestamptz;
alter table marketplace_fraud_alerts add column if not exists reviewed_by text;
do $$
begin
  alter table marketplace_fraud_alerts
    add constraint marketplace_fraud_alerts_status_check
    check (status in ('OPEN', 'REVIEWED', 'DISMISSED'));
exception when duplicate_object then null;
end $$;
create index if not exists marketplace_fraud_alerts_status_idx
  on marketplace_fraud_alerts (status, created_at desc);

create table if not exists marketplace_idempotency_requests (
  request_id text primary key,
  marketplace_client_id uuid references marketplace_clients(id) on delete set null,
  operation text not null,
  payload_hash text not null,
  status integer,
  response jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists marketplace_notifications (
  id uuid default gen_random_uuid() primary key,
  marketplace_client_id uuid not null references marketplace_clients(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

alter table marketplace_notifications add column if not exists read_at timestamptz;
alter table marketplace_notifications add column if not exists push_claimed_at timestamptz;
alter table marketplace_notifications add column if not exists push_attempts integer not null default 0;

create index if not exists marketplace_notifications_client_created_idx
  on marketplace_notifications (marketplace_client_id, created_at desc);

create or replace function notify_marketplace_queue_status()
returns trigger
language plpgsql
as $$
declare
  marketplace_id uuid;
  notification_type text;
  affected record;
  affected_marketplace_id uuid;
begin
  if coalesce(new.source, '') <> 'site' or (tg_op = 'UPDATE' and old.status = new.status) then
    return new;
  end if;

  notification_type := case new.status
    when 'waiting' then 'QUEUE_POSITION_CHANGED'
    when 'swapped' then 'QUEUE_POSITION_CHANGED'
    when 'called' then 'YOU_ARE_CALLED'
    when 'in_progress' then 'SERVICE_STARTED'
    when 'completed' then 'SERVICE_COMPLETED'
    when 'no_show' then 'NO_SHOW_PENALTY'
    else null
  end;
  if notification_type is null then return new; end if;

  select mc.id into marketplace_id
    from marketplace_clients mc
    join clients c on c.phone = mc.phone
   where c.id = new.client_id
   limit 1;
  if marketplace_id is null then return new; end if;

  insert into marketplace_notifications (marketplace_client_id, type, payload)
  select marketplace_id, notification_type, jsonb_build_object(
    'queue_entry_id', new.id,
    'status', new.status,
    'branch_id', new.branch_id,
    'barber_id', new.barber_id
  )
   where notification_type <> 'QUEUE_POSITION_CHANGED'
      or (select count(*) from marketplace_notifications n
           where n.marketplace_client_id = marketplace_id
             and n.type = 'QUEUE_POSITION_CHANGED'
           and n.payload ->> 'queue_entry_id' = new.id::text) < 3;

  -- Give the client an early warning once their live position reaches the
  -- first two places.  The unique logical check keeps repeated queue
  -- recalculations from creating push storms.
  if new.status in ('waiting', 'swapped') then
    if (
      select count(*) + 1
        from queue_entries q2
       where q2.barber_id = new.barber_id
         and q2.status in ('waiting', 'called', 'swapped', 'in_progress')
         and (q2.created_at < new.created_at or (q2.created_at = new.created_at and q2.id < new.id))
    ) <= 2 then
      insert into marketplace_notifications (marketplace_client_id, type, payload)
      select marketplace_id, 'ALMOST_YOUR_TURN', jsonb_build_object(
        'queue_entry_id', new.id,
        'queue_position', (
          select count(*) + 1
            from queue_entries q3
           where q3.barber_id = new.barber_id
             and q3.status in ('waiting', 'called', 'swapped', 'in_progress')
             and (q3.created_at < new.created_at or (q3.created_at = new.created_at and q3.id < new.id))
        ),
        'branch_id', new.branch_id,
        'barber_id', new.barber_id
      )
       where not exists (
         select 1 from marketplace_notifications n
          where n.marketplace_client_id = marketplace_id
            and n.type = 'ALMOST_YOUR_TURN'
            and n.payload ->> 'queue_entry_id' = new.id::text
       );
    end if;
  end if;

  -- A status change ahead of other clients changes their position/ETA too.
  -- Keep this bounded per queue entry to avoid notification storms.
  if new.status in ('called', 'in_progress', 'completed', 'no_show', 'cancelled') then
    for affected in
      select q.id, q.client_id, q.barber_id, q.branch_id
        from queue_entries q
       where q.branch_id = new.branch_id
         and q.barber_id = new.barber_id
         and q.status in ('waiting', 'swapped')
         and q.id <> new.id
    loop
      select mc.id into affected_marketplace_id
        from marketplace_clients mc
        join clients c on c.phone = mc.phone
       where c.id = affected.client_id
       limit 1;
      if affected_marketplace_id is not null and
         (select count(*) from marketplace_notifications n
           where n.marketplace_client_id = affected_marketplace_id
             and n.type = 'QUEUE_POSITION_CHANGED'
             and n.payload ->> 'queue_entry_id' = affected.id::text) < 3 then
        insert into marketplace_notifications (marketplace_client_id, type, payload)
        values (affected_marketplace_id, 'QUEUE_POSITION_CHANGED', jsonb_build_object(
          'queue_entry_id', affected.id,
          'status', affected.status,
          'branch_id', affected.branch_id,
          'barber_id', affected.barber_id,
          'cause_entry_id', new.id
        ));
      end if;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists marketplace_queue_status_notification on queue_entries;
create trigger marketplace_queue_status_notification
after insert or update of status on queue_entries
for each row execute function notify_marketplace_queue_status();

create table if not exists marketplace_push_tokens (
  marketplace_client_id uuid not null references marketplace_clients(id) on delete cascade,
  token text not null,
  platform text not null check (platform in ('ANDROID', 'IOS', 'WEB')),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (marketplace_client_id, token)
);

alter table marketplace_clients add column if not exists display_name text;
alter table marketplace_clients add column if not exists language text not null default 'ru';
alter table marketplace_clients drop constraint if exists marketplace_clients_language_check;
alter table marketplace_clients add constraint marketplace_clients_language_check check (language in ('uz', 'ru', 'en'));
alter table marketplace_clients alter column email drop not null;
alter table marketplace_clients add column if not exists status_points integer not null default 0;
alter table marketplace_clients add column if not exists cancel_count_today integer not null default 0;
alter table marketplace_clients add column if not exists cancel_count_date date;
alter table marketplace_clients add column if not exists no_show_streak integer not null default 0;
alter table marketplace_clients add column if not exists blocked_until timestamptz;
alter table marketplace_clients add column if not exists referral_bonus_balance numeric(12,2) not null default 0;

create unique index if not exists marketplace_clients_phone_uidx
  on marketplace_clients (phone)
  where phone is not null;

alter table otp_codes add column if not exists phone text;
alter table otp_codes add column if not exists referral_code text;
alter table otp_codes add column if not exists request_ip inet;
alter table otp_codes add column if not exists device_id text;
alter table otp_codes alter column email drop not null;
create index if not exists otp_codes_phone_idx on otp_codes (phone);

insert into platform_settings (key, value, description)
values
  ('booking_limits', '{"max_persons":4,"max_services_per_person":3,"max_duration_minutes":180,"max_daily_bookings":5}'::jsonb, 'Marketplace booking limits'),
  ('anti_fraud', '{"cancel_cooldown_minutes":15,"cancel_block_threshold":3,"no_show_block_threshold":5,"block_hours":24}'::jsonb, 'Marketplace anti-fraud settings'),
  ('status_points', '{"completed_service_points":10,"late_cancel_penalty":-10,"no_show_penalty":-30,"daily_positive_limit":20}'::jsonb, 'Marketplace status point rules'),
  ('loyalty_levels', '{"NONE":{"min_points":0,"cashback_percent":0},"BRONZE":{"min_points":100,"cashback_percent":1},"SILVER":{"min_points":300,"cashback_percent":2},"GOLD":{"min_points":1500,"cashback_percent":2.5}}'::jsonb, 'Marketplace status point levels'),
  ('cashback_policy', '{"max_redeem_share":1}'::jsonb, 'Maximum share of payable service total redeemable from cashback'),
  ('cashback', '{"default_percent":1,"promotion_percent":null,"promotion_start_date":null,"promotion_end_date":null,"timezone":"Asia/Tashkent"}'::jsonb, 'Marketplace cashback percentage and temporary promotion'),
  ('referral', '{"expiry_days":365,"bonus_percent":1,"daily_limit":10}'::jsonb, 'Marketplace referral settings')
on conflict (key) do nothing;

-- Correct the previous non-TZ defaults without overwriting administrator changes.
update platform_settings
   set value = jsonb_set(jsonb_set(value, '{no_show_penalty}', '-30'::jsonb), '{daily_positive_limit}', '20'::jsonb),
       updated_at = now()
 where key = 'status_points'
   and value ->> 'no_show_penalty' = '-20'
   and value ->> 'daily_positive_limit' = '100';

alter table marketplace_reviews add column if not exists barber_id uuid references barbers(id) on delete set null;
alter table marketplace_reviews add column if not exists shop_response text;
alter table marketplace_reviews add column if not exists shop_responded_at timestamptz;

create table if not exists marketplace_review_alerts (
  id uuid default gen_random_uuid() primary key,
  review_id uuid not null unique references marketplace_reviews(id) on delete cascade,
  barbershop_id uuid references marketplace_barbershops(id) on delete set null,
  rating smallint not null check (rating between 1 and 2),
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create or replace function marketplace_loyalty_level(points integer)
returns text
language sql
stable
as $$
  select coalesce((
    select level_name
      from jsonb_each(coalesce((select value from platform_settings where key = 'loyalty_levels'), '{}'::jsonb)) as levels(level_name, config)
     where coalesce((config ->> 'min_points')::integer, 0) <= coalesce(points, 0)
     order by coalesce((config ->> 'min_points')::integer, 0) desc
     limit 1
  ), 'NONE');
$$;

-- The cashback ledger is shared with kiosk and must be available before
-- marketplace completion/referral triggers run.
alter table cashback_transactions add column if not exists request_id text;

-- Marketplace online payment methods. Keep the legacy cash/card/certificate
-- methods intact while allowing Payme and Click to travel through the same
-- booking and completion ledger.
do $$
begin
  if to_regclass('public.queue_entries') is not null then
    alter table queue_entries drop constraint if exists queue_entries_payment_method_check;
    alter table queue_entries add constraint queue_entries_payment_method_check
      check (payment_method is null or payment_method in ('payme', 'click', 'cash', 'card', 'certificate', 'mixed'));
  end if;
  if to_regclass('public.payments') is not null then
    alter table payments drop constraint if exists payments_method_check;
    alter table payments add constraint payments_method_check
      check (method in ('payme', 'click', 'cash', 'card', 'certificate'));
  end if;
end $$;
alter table cashback_transactions add column if not exists reversal_of uuid references cashback_transactions(id) on delete restrict;
create unique index if not exists idx_cashback_transactions_request_id
  on cashback_transactions (request_id) where request_id is not null;
create unique index if not exists idx_cashback_transactions_reversal_kind
  on cashback_transactions (reversal_of, kind) where reversal_of is not null;
create index if not exists idx_cashback_transactions_created_at
  on cashback_transactions (created_at desc);
do $$
begin
  alter table cashback_wallets
    add constraint cashback_wallets_nonnegative_balance check (balance >= 0) not valid;
exception when duplicate_object then null;
end $$;

-- One-time migration of referral balances accumulated by the old separate
-- field into the shared cashback ledger. The request id makes this safe to
-- run repeatedly during deployment.
do $$
declare
  legacy record;
  inserted_id uuid;
begin
  for legacy in
    select mc.id as marketplace_client_id, c.id as client_id,
           mc.referral_bonus_balance as amount
      from marketplace_clients mc
      join clients c on c.phone = mc.phone
     where coalesce(mc.referral_bonus_balance, 0) > 0
  loop
    insert into cashback_transactions (client_id, kind, amount, meta, request_id)
    values (
      legacy.client_id,
      'adjust',
      legacy.amount,
      jsonb_build_object('source', 'referral', 'legacy_migration', true,
                         'description', 'Referral bonus migrated to shared wallet'),
      'referral_legacy_balance:' || legacy.marketplace_client_id::text
    )
    on conflict (request_id) do nothing
    returning id into inserted_id;

    if inserted_id is not null then
      insert into cashback_wallets (client_id, balance)
      values (legacy.client_id, legacy.amount)
      on conflict (client_id) do update
        set balance = round((cashback_wallets.balance + excluded.balance)::numeric, 2),
            updated_at = now();
    end if;
  end loop;
end $$;

create table if not exists cashback_settlements (
  id uuid default gen_random_uuid() primary key,
  queue_entry_id uuid not null unique references queue_entries(id) on delete restrict,
  branch_id uuid references branches(id) on delete set null,
  client_id uuid not null references clients(id) on delete restrict,
  cashback_amount numeric(12,2) not null check (cashback_amount >= 0),
  status text not null default 'PENDING' check (status in ('PENDING', 'SETTLED', 'REVERSED')),
  settled_at timestamptz,
  processed_at timestamptz,
  processed_by text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cashback_settlements_branch_status_idx
  on cashback_settlements (branch_id, status, created_at desc);

alter table cashback_settlements add column if not exists processed_at timestamptz;
alter table cashback_settlements add column if not exists processed_by text;

create table if not exists cashback_reconciliation_alerts (
  id uuid default gen_random_uuid() primary key,
  client_id uuid not null references clients(id) on delete cascade,
  wallet_balance numeric(12,2) not null,
  ledger_balance numeric(12,2) not null,
  difference numeric(12,2) not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED')),
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists cashback_reconciliation_open_client_uidx
  on cashback_reconciliation_alerts (client_id) where status = 'OPEN';

create index if not exists cashback_reconciliation_status_detected_idx
  on cashback_reconciliation_alerts (status, detected_at desc);

-- Keep the marketplace booking aggregate synchronized with the shared queue.
-- Queue entries remain the operational source of truth for barber/kiosk flows.
create or replace function sync_marketplace_booking_from_queue()
returns trigger
language plpgsql
as $$
begin
  if new.source = 'site' and new.status in ('completed', 'no_show', 'cancelled', 'rejected', 'not_in_time') then
    update marketplace_bookings b
       set status = case
         when exists (
           select 1
             from marketplace_booking_persons bp
             join queue_entries q on q.id = bp.queue_entry_id
            where bp.booking_id = b.id and q.status = 'no_show'
         ) then 'NO_SHOW'
         when exists (
           select 1
             from marketplace_booking_persons bp
             join queue_entries q on q.id = bp.queue_entry_id
            where bp.booking_id = b.id and q.status = 'completed'
         ) then 'COMPLETED'
         else 'CANCELLED'
       end,
       updated_at = now()
     where b.status = 'ACTIVE'
       and b.id = (
         select bp.booking_id
           from marketplace_booking_persons bp
          where bp.queue_entry_id = new.id
          limit 1
       )
       and not exists (
         select 1
           from marketplace_booking_persons bp
           join queue_entries q on q.id = bp.queue_entry_id
          where bp.booking_id = b.id
            and q.status in ('waiting', 'called', 'swapped', 'in_progress')
       );
  end if;
  return new;
end;
$$;

drop trigger if exists marketplace_booking_queue_sync on queue_entries;
create trigger marketplace_booking_queue_sync
after insert or update of status on queue_entries
for each row execute function sync_marketplace_booking_from_queue();

create or replace function apply_marketplace_status_points_from_queue()
returns trigger
language plpgsql
as $$
declare
  marketplace_id uuid;
  points_config jsonb;
  points_amount integer;
  positive_today integer;
  no_show_count integer;
  block_threshold integer;
  old_level text;
  new_level text;
begin
  if coalesce(new.source, '') <> 'site' or (tg_op = 'UPDATE' and old.status = new.status) then
    return new;
  end if;

  select mc.id into marketplace_id
    from marketplace_clients mc
    join clients c on c.phone = mc.phone
   where c.id = new.client_id limit 1;
  if marketplace_id is null then return new; end if;

  -- Serialize status-point updates per marketplace client.  Without this
  -- lock, two concurrent completions could both observe the same daily
  -- positive-point total and exceed the configured cap.
  perform 1 from marketplace_clients where id = marketplace_id for update;

  points_config := coalesce((select value from platform_settings where key = 'status_points'), '{}'::jsonb);
  if new.status = 'completed' then
    select marketplace_loyalty_level(status_points) into old_level
      from marketplace_clients where id = marketplace_id;
    points_amount := greatest(0, coalesce((points_config ->> 'completed_service_points')::integer, 10));
    -- A successfully completed service breaks the no-show streak even when
    -- the daily positive-points cap has already been reached.
    update marketplace_clients set no_show_streak = 0 where id = marketplace_id;
    positive_today := coalesce((select sum(amount) from status_point_transactions
      where marketplace_client_id = marketplace_id and amount > 0
        and (created_at at time zone 'Asia/Tashkent')::date = (now() at time zone 'Asia/Tashkent')::date), 0);
    if positive_today + points_amount <= coalesce((points_config ->> 'daily_positive_limit')::integer, 100) then
      insert into status_point_transactions (marketplace_client_id, queue_entry_id, kind, amount, reason)
      values (marketplace_id, new.id, 'EARN', points_amount, 'COMPLETED_SERVICE')
      on conflict (queue_entry_id, kind) where queue_entry_id is not null do nothing;
      if found then
        update marketplace_clients set status_points = status_points + points_amount, no_show_streak = 0 where id = marketplace_id;
        select marketplace_loyalty_level(status_points) into new_level
          from marketplace_clients where id = marketplace_id;
        if old_level is distinct from new_level then
          insert into marketplace_notifications (marketplace_client_id, type, payload)
          values (marketplace_id, 'LEVEL_CHANGED', jsonb_build_object('old_level', old_level, 'new_level', new_level));
        end if;
      end if;
    end if;
  elsif new.status = 'no_show' then
    select marketplace_loyalty_level(status_points) into old_level
      from marketplace_clients where id = marketplace_id for update;
    points_amount := least(-1, coalesce((points_config ->> 'no_show_penalty')::integer, -20));
    insert into status_point_transactions (marketplace_client_id, queue_entry_id, kind, amount, reason)
    values (marketplace_id, new.id, 'PENALTY', points_amount, 'NO_SHOW')
    on conflict (queue_entry_id, kind) where queue_entry_id is not null do nothing;
    if found then
      update marketplace_clients set
        status_points = greatest(0, status_points + points_amount),
        no_show_streak = no_show_streak + 1
      where id = marketplace_id;
      select marketplace_loyalty_level(status_points) into new_level
        from marketplace_clients where id = marketplace_id;
      if old_level is distinct from new_level then
        insert into marketplace_notifications (marketplace_client_id, type, payload)
        values (marketplace_id, 'LEVEL_CHANGED', jsonb_build_object(
          'old_level', old_level,
          'new_level', new_level,
          'reason', 'NO_SHOW'));
      end if;
      select no_show_streak into no_show_count from marketplace_clients where id = marketplace_id;
      block_threshold := coalesce((select (value ->> 'no_show_block_threshold')::integer from platform_settings where key = 'anti_fraud'), 5);
      if no_show_count >= block_threshold then
        update marketplace_clients
           set blocked_until = now() + make_interval(hours => coalesce((select (value ->> 'block_hours')::integer from platform_settings where key = 'anti_fraud'), 24))
         where id = marketplace_id;
        insert into marketplace_notifications (marketplace_client_id, type, payload)
        values (marketplace_id, 'ACCOUNT_BLOCKED', jsonb_build_object(
          'blocked_until', now() + make_interval(hours => coalesce((select (value ->> 'block_hours')::integer from platform_settings where key = 'anti_fraud'), 24)),
          'reason', 'NO_SHOW_LIMIT'));
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists marketplace_status_points_queue_sync on queue_entries;
create trigger marketplace_status_points_queue_sync
after insert or update of status on queue_entries
for each row execute function apply_marketplace_status_points_from_queue();

create or replace function apply_marketplace_referral_bonus_from_queue()
returns trigger
language plpgsql
as $$
declare
  referred_marketplace_id uuid;
  referral_row record;
  paid_money numeric(12,2);
  bonus_percent numeric;
  bonus_amount numeric(12,2);
  referral_transaction_id uuid;
  referrer_phone text;
  referrer_name text;
  cashback_client_id uuid;
begin
  if coalesce(new.source, '') <> 'site' or new.status <> 'completed' or (tg_op = 'UPDATE' and old.status = new.status) then
    return new;
  end if;

  select mc.id into referred_marketplace_id
    from marketplace_clients mc
    join clients c on c.phone = mc.phone
   where c.id = new.client_id limit 1;
  if referred_marketplace_id is null then return new; end if;

  select r.id, r.referrer_client_id, r.expires_at, b.id as booking_id
    into referral_row
    from referrals r
    join marketplace_bookings b on b.marketplace_client_id = r.referred_client_id
    join marketplace_booking_persons bp on bp.booking_id = b.id and bp.queue_entry_id = new.id
   where r.referred_client_id = referred_marketplace_id
     and r.expires_at > now()
     and b.status = 'COMPLETED'
   order by b.created_at desc limit 1;
  if referral_row.id is null then return new; end if;

  select round((
      coalesce(sum(pay.amount) filter (where pay.method in ('payme', 'click', 'cash', 'card')), 0)
      + coalesce(sum(case when pay.id is null and q.payment_method in ('payme', 'click', 'cash', 'card') then
          coalesce(q.price_override,
            (select sum(s.base_price) from services s where s.id = any(q.service_ids)),
            (select s.base_price from services s where s.id = q.service_id), 0)
        else 0 end), 0)
    )::numeric, 2) into paid_money
    from marketplace_booking_persons bp
    join queue_entries q on q.id = bp.queue_entry_id
    left join payments pay on pay.queue_entry_id = bp.queue_entry_id
   where bp.booking_id = referral_row.booking_id;
  if paid_money <= 0 then return new; end if;
  bonus_percent := coalesce((select (value ->> 'bonus_percent')::numeric from platform_settings where key = 'referral'), 1);
  bonus_amount := round(paid_money * bonus_percent / 100, 2);
  if bonus_amount <= 0 then return new; end if;

  insert into referral_transactions (referral_id, booking_id, amount, paid_with_money)
  values (referral_row.id, referral_row.booking_id, bonus_amount, paid_money)
  on conflict (referral_id, booking_id) do nothing
  returning id into referral_transaction_id;
  if found then
    select phone, coalesce(nullif(display_name, ''), 'Client')
      into referrer_phone, referrer_name
      from marketplace_clients
     where id = referral_row.referrer_client_id;

    if referrer_phone is not null and referrer_phone <> '' then
      insert into clients (name, phone)
      values (referrer_name, referrer_phone)
      on conflict (phone) do update
        set name = coalesce(nullif(clients.name, ''), excluded.name)
      returning id into cashback_client_id;

      insert into cashback_wallets (client_id, balance)
      values (cashback_client_id, 0)
      on conflict (client_id) do nothing;

      insert into cashback_transactions
        (client_id, kind, amount, meta, request_id)
      values (
        cashback_client_id,
        'adjust',
        bonus_amount,
        jsonb_build_object(
          'source', 'referral_bonus',
          'booking_id', referral_row.booking_id,
          'referral_transaction_id', referral_transaction_id,
          'description', 'Referral bonus'
        ),
        'referral_bonus:' || referral_transaction_id::text
      )
      on conflict (request_id) do nothing;

      if found then
        update cashback_wallets
           set balance = round((balance + bonus_amount)::numeric, 2), updated_at = now()
         where client_id = cashback_client_id;
      end if;
    end if;

    insert into marketplace_notifications (marketplace_client_id, type, payload)
    values (referral_row.referrer_client_id, 'REFERRAL_BONUS', jsonb_build_object('amount', bonus_amount, 'booking_id', referral_row.booking_id));
  end if;
  return new;
end;
$$;

drop trigger if exists marketplace_referral_bonus_queue_sync on queue_entries;
create trigger marketplace_referral_bonus_queue_sync
after insert or update of status on queue_entries
for each row execute function apply_marketplace_referral_bonus_from_queue();
