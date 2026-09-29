-- Job type is chosen when the quote is made, not when the customer is added.
alter table jobs alter column job_type_id drop not null;

-- Deleting a quote is a soft delete so every phone hears about it on its next sync.
alter table jobs add column if not exists deleted_at timestamptz;

-- A customer can decline a quote from their link.
alter table jobs add column if not exists declined_at timestamptz;
alter table jobs add column if not exists decline_reason text;

-- Payments received on the job: [{id, amount_cents, method, date, note}].
alter table jobs add column if not exists payments jsonb not null default '[]'::jsonb;

create index if not exists jobs_business_deleted on jobs (business_id, deleted_at) where deleted_at is not null;
