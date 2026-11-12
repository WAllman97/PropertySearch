-- Price drops, time on market, and local sold-price comparisons.
-- Run once in the Supabase SQL editor. Safe to re-run.

-- 1. Listing facts captured from the portals ---------------------------------

alter table properties
  add column if not exists latitude          double precision,
  add column if not exists longitude         double precision,
  add column if not exists postcode          text,          -- full postcode when the portal gives it
  add column if not exists property_sub_type text,          -- portal wording, e.g. "End of Terrace"
  add column if not exists property_type     text,          -- flat | terraced | semi-detached | detached | house
  add column if not exists tenure            text,
  add column if not exists size_sqft         integer,
  add column if not exists first_listed_at   timestamptz,   -- when the portal first showed it (not when we found it)
  add column if not exists price_reduced_at  timestamptz,   -- portal's latest "Reduced on" date
  add column if not exists initial_price     integer,       -- first asking price we saw
  add column if not exists last_price_change_at timestamptz,
  add column if not exists listing_status    text,          -- live | under_offer | sold_stc | removed
  add column if not exists listing_checked_at timestamptz,
  add column if not exists comps             jsonb,         -- Land Registry summary, see backend/core/sales_comps.py
  add column if not exists comps_updated_at  timestamptz;

-- 2. Every asking price we've observed ----------------------------------------

create table if not exists price_history (
  id           bigserial primary key,
  property_id  uuid not null references properties (id) on delete cascade,
  price        integer not null,
  observed_at  timestamptz not null default now(),
  source       text not null default 'scrape'   -- scrape | listing_page | initial
);

create index if not exists price_history_property_idx
  on price_history (property_id, observed_at desc);

-- Same household-only access as properties (see 002).
alter table price_history enable row level security;

drop policy if exists household_only on price_history;
create policy household_only on price_history as restrictive for all
  to public using (is_household_member()) with check (is_household_member());

drop policy if exists household_access on price_history;
create policy household_access on price_history
  for all to authenticated
  using (is_household_member()) with check (is_household_member());

-- 3. Seed history with today's price for what we already have -----------------

insert into price_history (property_id, price, observed_at, source)
select p.id, p.price, coalesce(p.created_at, now()), 'initial'
from properties p
where p.price is not null
  and not exists (select 1 from price_history h where h.property_id = p.id);

update properties set initial_price = price
where initial_price is null and price is not null;
