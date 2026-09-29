-- Itemized quotes. Prices live in a per-business price list (catalog_items); a quote copies the lines it uses
-- (name, unit, qty, price), so changing the price list later never alters a quote already sent.
alter table businesses add column tax_rate_bps int not null default 0 check (tax_rate_bps between 0 and 2500);

create table catalog_items (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete cascade,
  name              text not null check (length(name) between 1 and 120),
  unit              text not null check (length(unit) between 1 and 20),
  unit_price_cents  int  not null check (unit_price_cents between 0 and 100000000),
  job_type_id       uuid,                       -- suggested for this job type; null = suggest for all
  sort_order        int  not null default 0,
  active            boolean not null default true,
  unique (business_id, id),
  foreign key (business_id, job_type_id) references job_types(business_id, id)
);
create index catalog_items_biz_idx on catalog_items (business_id, sort_order);

-- The quote itself is one JSON document on the job (edited from the app, synced like other job fields).
-- Accepting is written only by the server, from the public quote page.
alter table jobs
  add column quote jsonb,
  add column quote_accepted_at timestamptz,
  add column quote_accepted_by text check (quote_accepted_by is null or length(quote_accepted_by) <= 120);
create unique index jobs_quote_token_idx on jobs ((quote->>'token')) where quote is not null;
