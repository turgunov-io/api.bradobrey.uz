create table if not exists branches (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  address text,
  city text,
  work_hours jsonb,
  timezone text,
  marketplace_barbershop_id uuid,
  is_active boolean default true
);

alter table if exists branches
  add column if not exists marketplace_barbershop_id uuid;

-- Optional branch photo (uploaded via PATCH/POST /api/branches, multipart field "photo").
alter table if exists branches
  add column if not exists photo_url text;
