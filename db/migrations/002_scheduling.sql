-- Scheduling: an optional date (and optional time of day) on each job. Additive and nullable,
-- so existing rows and older app versions keep working.
alter table jobs add column scheduled_date date;
alter table jobs add column scheduled_time time;
create index jobs_schedule_idx on jobs (business_id, scheduled_date) where scheduled_date is not null;
