create table if not exists branches (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  address text,
  city text,
  work_hours jsonb,
  timezone text,
  is_active boolean default true
);
