-- Install invitations. The owner creates one per person; only a SHA-256 of the token is stored.
--   kind 'install' : opens the install page; used up the first time the installed app opens with it.
--   kind 'browser' : owner override, lets that person sign in from a browser tab until it expires.
create table invites (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  token_hash   text not null unique,
  kind         text not null default 'install' check (kind in ('install', 'browser')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz
);
create index invites_business_idx on invites (business_id, created_at desc);
