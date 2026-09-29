-- Hardening: environment marker, per-line tax, acceptance evidence, business time zone,
-- trusted devices (lock-out protection), push alerts, sync housekeeping.

-- A marker that says which environment a database is. The dev branch gets the row 'dev' (see scripts/lib/guard.js);
-- production never does, so tests and demo seeding refuse to run there.
create table if not exists tt_env (key text primary key, value text not null);

-- Per-line tax: the price-list item's default, and the quote line's own flag lives in the quote JSON.
alter table catalog_items add column taxable boolean not null default true;

-- What we can show if an acceptance is ever questioned.
alter table jobs add column quote_accept_meta jsonb;

-- Quotes expire at the end of the business's own day, not the server's (UTC) day.
alter table businesses add column timezone text not null default 'America/Chicago' check (length(timezone) between 3 and 60);

-- A browser/phone that has signed in before. It keeps working while someone else is guessing PINs.
create table trusted_devices (
  token_hash  text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);
create index trusted_devices_biz_idx on trusted_devices (business_id);

-- Web-push subscriptions ("a customer accepted your quote").
create table push_subscriptions (
  endpoint    text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index push_subscriptions_biz_idx on push_subscriptions (business_id);

create index if not exists client_tombstones_deleted_idx on client_tombstones (deleted_at);
