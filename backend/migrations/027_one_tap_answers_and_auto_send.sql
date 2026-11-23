-- Run once in the Supabase SQL editor.
--
-- 1. One-tap answers from emails, no login:
--    - the agent confirms or corrects a buyer's accepted offer
--      (/offer/<agent_token>)
--    - the buyer accepts or declines a time the agent suggested
--      (/suggested/<buyer_token>)
-- 2. Listings go to matching buyers automatically (agent_listings.auto_send),
--    including buyers whose search is saved after the listing was added.
-- 3. A 7am run-sheet email for agents with viewings that day.

-- 1. ------------------------------------------------------------------------

alter table offers
  add column if not exists agent_token uuid not null default gen_random_uuid();
create unique index if not exists offers_agent_token on offers (agent_token);

alter table viewing_requests
  add column if not exists buyer_token uuid not null default gen_random_uuid();
create unique index if not exists viewing_requests_buyer_token on viewing_requests (buyer_token);

-- 2. ------------------------------------------------------------------------

alter table agent_listings
  add column if not exists auto_send boolean not null default true;

-- Live listings a buyer's search fits that haven't been sent to them yet:
-- the reverse of match_buyer_searches, for when a buyer saves a search.
create or replace function listings_for_search(p_search uuid)
returns table (listing_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select l.id
  from agent_listings l
  join buyer_searches s on s.id = p_search and s.is_active
  where l.is_active
    and l.auto_send
    and l.market_status in ('available', 'under_offer')
    and l.postcode is not null
    and l.agent_id <> s.user_id
    and not exists (
      select 1 from listing_sends x where x.listing_id = l.id and x.user_id = s.user_id
    )
    and exists (
      select 1
      from match_buyer_searches(l.postcode, l.price, l.bedrooms, l.property_type, l.has_garden) m
      where m.search_id = s.id
    );
$$;

revoke all on function listings_for_search(uuid) from public, anon, authenticated;
grant execute on function listings_for_search(uuid) to service_role;

-- 3. ------------------------------------------------------------------------

alter table agents
  add column if not exists runsheet_sent_on date;

-- Check
select
  (select count(*) from offers where agent_token is not null) as offers_with_link,
  (select count(*) from viewing_requests where buyer_token is not null) as requests_with_link,
  (select count(*) from agent_listings where auto_send) as listings_auto_sending;
