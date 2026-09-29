-- Quote v2 + workflow extras.
-- Price list: line kinds (item/labor/allowance/fee/discount/surcharge) and a PRIVATE unit cost (never shown to customers).
-- For kind = 'surcharge', unit_price_cents holds the percent in hundredths (50.00% = 5000).
alter table catalog_items
  add column kind text not null default 'item' check (kind in ('item','labor','allowance','fee','discount','surcharge')),
  add column unit_cost_cents int check (unit_cost_cents is null or unit_cost_cents between 0 and 100000000);

-- Business settings shown on / used by quotes.
alter table businesses
  add column license_no        text check (license_no is null or length(license_no) <= 60),
  add column quote_terms       text check (quote_terms is null or length(quote_terms) <= 2000),
  add column min_charge_cents  int  not null default 0 check (min_charge_cents between 0 and 100000000),
  add column uses_visits       boolean not null default true,
  add column default_deposit_pct int not null default 50 check (default_deposit_pct between 0 and 100),
  add column valid_days        int  not null default 30 check (valid_days between 1 and 365);

-- Jobs: the customer's chosen package/options when they accept, multi-day jobs, crew/sub, change orders, recurring.
create unique index if not exists jobs_biz_id_uidx on jobs (business_id, id);
alter table jobs
  add column quote_selection jsonb,
  add column quote_accepted_total_cents int check (quote_accepted_total_cents is null or quote_accepted_total_cents >= 0),
  add column parent_job_id uuid,
  add column duration_days int not null default 1 check (duration_days between 1 and 60),
  add column assigned_to text check (assigned_to is null or length(assigned_to) <= 60),
  add column recurrence jsonb,
  add constraint jobs_parent_fk foreign key (business_id, parent_job_id) references jobs (business_id, id) on delete cascade;
create index jobs_parent_idx on jobs (business_id, parent_job_id) where parent_job_id is not null;
