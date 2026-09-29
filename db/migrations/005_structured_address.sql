-- Structured, complete addresses: house number + street, city, state, ZIP. All four or none, so a row can
-- never hold half an address. Older rows keep their free-text `address` until someone completes them.
alter table clients
  add column address_line text check (address_line is null or length(address_line) between 3 and 120),
  add column city         text check (city is null or length(city) between 2 and 60),
  add column state        text check (state is null or state ~ '^[A-Z]{2}$'),
  add column zip          text check (zip is null or zip ~ '^[0-9]{5}$'),
  add constraint clients_address_all_or_none check (
    (address_line is null and city is null and state is null and zip is null)
    or (address_line is not null and city is not null and state is not null and zip is not null));
