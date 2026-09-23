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

create index if not exists marketplace_notifications_client_created_idx
  on marketplace_notifications (marketplace_client_id, created_at desc);

create table if not exists marketplace_push_tokens (
  marketplace_client_id uuid not null references marketplace_clients(id) on delete cascade,
  token text not null,
  platform text not null check (platform in ('ANDROID', 'IOS', 'WEB')),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (marketplace_client_id, token)
);

alter table marketplace_clients add column if not exists display_name text;
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
  ('status_points', '{"completed_service_points":10,"late_cancel_penalty":-10,"no_show_penalty":-20,"daily_positive_limit":100}'::jsonb, 'Marketplace status point rules'),
  ('loyalty_levels', '{"NONE":{"min_points":0,"cashback_percent":0},"BRONZE":{"min_points":100,"cashback_percent":1},"SILVER":{"min_points":300,"cashback_percent":2},"GOLD":{"min_points":1500,"cashback_percent":2.5}}'::jsonb, 'Marketplace status point levels'),
  ('referral', '{"expiry_days":365,"bonus_percent":1,"daily_limit":10}'::jsonb, 'Marketplace referral settings')
on conflict (key) do nothing;

-- Keep the marketplace booking aggregate synchronized with the shared queue.
-- Queue entries remain the operational source of truth for barber/kiosk flows.
create or replace function sync_marketplace_booking_from_queue()
returns trigger
language plpgsql
as $$
begin
  if new.source = 'site' then
    update marketplace_bookings b
       set status = case
         when new.status = 'completed' then 'COMPLETED'
         when new.status = 'no_show' then 'NO_SHOW'
         when new.status in ('cancelled', 'rejected', 'not_in_time') then 'CANCELLED'
         else b.status
       end,
       updated_at = now()
     where b.status = 'ACTIVE'
       and b.marketplace_client_id = (
         select mc.id
           from marketplace_clients mc
           join clients c on c.phone = mc.phone
          where c.id = new.client_id
          limit 1
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
begin
  if coalesce(new.source, '') <> 'site' or (tg_op = 'UPDATE' and old.status = new.status) then
    return new;
  end if;

  select mc.id into marketplace_id
    from marketplace_clients mc
    join clients c on c.phone = mc.phone
   where c.id = new.client_id limit 1;
  if marketplace_id is null then return new; end if;

  points_config := coalesce((select value from platform_settings where key = 'status_points'), '{}'::jsonb);
  if new.status = 'completed' then
    points_amount := greatest(0, coalesce((points_config ->> 'completed_service_points')::integer, 10));
    positive_today := coalesce((select sum(amount) from status_point_transactions
      where marketplace_client_id = marketplace_id and amount > 0 and created_at >= current_date), 0);
    if positive_today + points_amount <= coalesce((points_config ->> 'daily_positive_limit')::integer, 100) then
      insert into status_point_transactions (marketplace_client_id, queue_entry_id, kind, amount, reason)
      values (marketplace_id, new.id, 'EARN', points_amount, 'COMPLETED_SERVICE')
      on conflict (queue_entry_id, kind) where queue_entry_id is not null do nothing;
      if found then
        update marketplace_clients set status_points = status_points + points_amount, no_show_streak = 0 where id = marketplace_id;
      end if;
    end if;
  elsif new.status = 'no_show' then
    points_amount := least(-1, coalesce((points_config ->> 'no_show_penalty')::integer, -20));
    insert into status_point_transactions (marketplace_client_id, queue_entry_id, kind, amount, reason)
    values (marketplace_id, new.id, 'PENALTY', points_amount, 'NO_SHOW')
    on conflict (queue_entry_id, kind) where queue_entry_id is not null do nothing;
    if found then
      update marketplace_clients set
        status_points = greatest(0, status_points + points_amount),
        no_show_streak = no_show_streak + 1
      where id = marketplace_id;
      select no_show_streak into no_show_count from marketplace_clients where id = marketplace_id;
      block_threshold := coalesce((select (value ->> 'no_show_block_threshold')::integer from platform_settings where key = 'anti_fraud'), 5);
      if no_show_count >= block_threshold then
        update marketplace_clients set blocked_until = now() + interval '24 hours' where id = marketplace_id;
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

  select coalesce(sum(pay.amount), 0) into paid_money
    from marketplace_booking_persons bp
    join payments pay on pay.queue_entry_id = bp.queue_entry_id
   where bp.booking_id = referral_row.booking_id and pay.method in ('cash', 'card');
  if paid_money <= 0 then return new; end if;
  bonus_percent := coalesce((select (value ->> 'bonus_percent')::numeric from platform_settings where key = 'referral'), 1);
  bonus_amount := round(paid_money * bonus_percent / 100, 2);
  if bonus_amount <= 0 then return new; end if;

  insert into referral_transactions (referral_id, booking_id, amount, paid_with_money)
  values (referral_row.id, referral_row.booking_id, bonus_amount, paid_money)
  on conflict (referral_id, booking_id) do nothing;
  if found then
    update marketplace_clients set referral_bonus_balance = referral_bonus_balance + bonus_amount
     where id = referral_row.referrer_client_id;
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
