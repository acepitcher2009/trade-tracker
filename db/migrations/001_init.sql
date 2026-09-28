-- Trade Tracker initial schema. Every tenant-owned table carries business_id, and
-- child rows use COMPOSITE foreign keys (business_id, id) so a row can never point
-- at another business's parent row, even if application code has a bug.

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

create table businesses (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name          text not null check (length(name) between 1 and 120),
  phone_digits  text check (phone_digits ~ '^[0-9]{10}$'),
  city          text,
  state         text,
  preset        text not null,
  accent_color  text not null default '#1d4ed8' check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  -- terminology, e.g. {"client":"Client","clients":"Clients","job":"Job","jobs":"Jobs"}
  terms         jsonb not null default '{}'::jsonb,
  pin_hash      text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger businesses_updated before update on businesses
  for each row execute function set_updated_at();

create table job_types (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  name         text not null check (length(name) between 1 and 80),
  sort_order   int  not null default 0,
  active       boolean not null default true,
  unique (business_id, id),
  unique (business_id, name)
);

create table statuses (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  key          text not null check (key ~ '^[a-z0-9_]+$'),
  label        text not null check (length(label) between 1 and 40),
  sort_order   int  not null default 0,
  color        text not null default '#64748b' check (color ~ '^#[0-9a-fA-F]{6}$'),
  unique (business_id, id),
  unique (business_id, key)
);

create table clients (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  name          text not null check (length(name) between 1 and 120),
  phone_digits  text not null check (phone_digits ~ '^[0-9]{10}$'),
  address       text check (length(address) <= 300),
  notes         text check (length(notes) <= 4000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (business_id, id),
  -- the same number can never create two clients in one business
  unique (business_id, phone_digits)
);
create index clients_last4_idx on clients (business_id, right(phone_digits, 4));
create trigger clients_updated before update on clients
  for each row execute function set_updated_at();

create table jobs (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  client_id     uuid not null,
  job_type_id   uuid not null,
  status_id     uuid not null,
  notes         text check (length(notes) <= 4000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (business_id, client_id)   references clients(business_id, id)   on delete cascade,
  foreign key (business_id, job_type_id) references job_types(business_id, id),
  foreign key (business_id, status_id)   references statuses(business_id, id)
);
create index jobs_client_idx on jobs (business_id, client_id, created_at desc);
create trigger jobs_updated before update on jobs
  for each row execute function set_updated_at();

-- Server-side sessions. Only a SHA-256 of the token is stored.
create table sessions (
  token_hash   text primary key,
  business_id  uuid not null references businesses(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index sessions_expiry_idx on sessions (expires_at);

-- PIN login rate limiting (keyed by e.g. "ip|slug").
create table login_attempts (
  id            bigserial primary key,
  key           text not null,
  succeeded     boolean not null default false,
  attempted_at  timestamptz not null default now()
);
create index login_attempts_key_idx on login_attempts (key, attempted_at desc);
