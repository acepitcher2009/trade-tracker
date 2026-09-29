-- A scheduled job must have a start time, on the hour or half hour. NOT VALID: enforced for every new or
-- changed row without rejecting any older rows that pre-date this rule.
alter table jobs add constraint jobs_schedule_time_chk check (
  scheduled_date is null
  or (scheduled_time is not null and extract(minute from scheduled_time) in (0, 30))
) not valid;
