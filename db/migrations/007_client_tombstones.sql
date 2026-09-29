-- Deleting a client removes the client and (by cascade) its jobs. A tombstone row lets other
-- devices learn about the deletion on their next sync. No FK to clients: the row must outlive it.
create table if not exists client_tombstones (
  business_id uuid not null references businesses(id) on delete cascade,
  client_id   uuid not null,
  deleted_at  timestamptz not null default now(),
  primary key (business_id, client_id)
);
create index if not exists client_tombstones_at_idx on client_tombstones (business_id, deleted_at);
