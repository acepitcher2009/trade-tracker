-- Workflow: New (call came in) > Visit (site visit booked) > Quoted (quote sent) > Accepted (customer said yes)
--           > Scheduled (job booked) > Done > Paid.  Adds the two new stages and fixes the order everywhere.
insert into statuses (business_id, key, label, sort_order, color)
select b.id, 'visit', 'Visit', 1, '#0891b2' from businesses b
 where not exists (select 1 from statuses n where n.business_id = b.id and n.key = 'visit');
insert into statuses (business_id, key, label, sort_order, color)
select b.id, 'accepted', 'Accepted', 3, '#db2777' from businesses b
 where not exists (select 1 from statuses n where n.business_id = b.id and n.key = 'accepted');
update statuses set sort_order = case key
  when 'new' then 0 when 'visit' then 1 when 'quoted' then 2 when 'accepted' then 3
  when 'scheduled' then 4 when 'done' then 5 when 'paid' then 6 else sort_order end
 where key in ('new','visit','quoted','accepted','scheduled','done','paid');
