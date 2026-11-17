-- Agents send listings to matching buyers: run once in the Supabase SQL
-- editor, after 009.
--
-- Listings get the details buyers' searches match on (postcode, bedrooms,
-- type, garden) plus a photo. listing_sends records who each listing has
-- been sent to, so nobody gets the same listing twice.

-- 1. Listing details ----------------------------------------------------------

alter table agent_listings
  add column if not exists postcode text
    check (postcode is null or postcode_district(postcode) is not null),
  add column if not exists bedrooms smallint
    check (bedrooms is null or bedrooms between 0 and 20),
  add column if not exists property_type text
    check (property_type is null or property_type in ('house', 'flat', 'bungalow')),
  add column if not exists has_garden boolean,
  add column if not exists image_url text
    check (image_url is null or (image_url ~* '^https://' and length(image_url) <= 1000));

-- 2. Send log -----------------------------------------------------------------

create table if not exists listing_sends (
  listing_id uuid not null references agent_listings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (listing_id, user_id)
);

-- Service role only (the /api/send-listing route). Agents see counts through
-- agent_listing_reach() below, never who.
alter table listing_sends enable row level security;

-- 3. Per-listing reach for the agent's dashboard --------------------------------
--
-- For each of the caller's own listings: how many buyers match now, and how
-- many it has already been sent to.

create or replace function agent_listing_reach()
returns table (listing_id uuid, matching integer, sent integer)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    (select count(distinct m.user_id)::integer
       from match_buyer_searches(l.postcode, l.price, l.bedrooms, l.property_type, l.has_garden) m
       where m.user_id <> l.agent_id),
    (select count(*)::integer from listing_sends s where s.listing_id = l.id)
  from agent_listings l
  where l.agent_id = auth.uid();
$$;

revoke all on function agent_listing_reach() from public, anon;
grant execute on function agent_listing_reach() to authenticated;
