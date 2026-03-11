create table if not exists clients (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  phone text unique not null,
  first_visit_date date default current_date
);
