create table if not exists otp_codes (
  id uuid default gen_random_uuid() primary key,
  email text not null,
  code text not null,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists otp_codes_email_idx on otp_codes (email);
create index if not exists otp_codes_expires_at_idx on otp_codes (expires_at);
create index if not exists otp_codes_email_code_used_idx on otp_codes (email, code, used);

