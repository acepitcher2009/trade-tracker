-- A job is "New" until a quote has actually been sent. Adds that first status to existing businesses.
update statuses s set sort_order = sort_order + 1
 where not exists (select 1 from statuses n where n.business_id = s.business_id and n.key = 'new');
insert into statuses (business_id, key, label, sort_order, color)
select b.id, 'new', 'New', 0, '#7c3aed' from businesses b
 where not exists (select 1 from statuses n where n.business_id = b.id and n.key = 'new');
