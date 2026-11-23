-- Agent listing status and price reductions: run once in the Supabase SQL editor.
--
-- Agents mark a listing For sale / Under offer / Sold STC / Off market, and
-- cut the price in one step. The status is passed on to every household that
-- saved the home (properties.listing_status: live | under_offer | sold_stc |
-- removed), so buyers' lists stay right without reading portals.

alter table agent_listings
  add column if not exists market_status text not null default 'available'
    check (market_status in ('available', 'under_offer', 'sold_stc', 'off_market')),
  -- The asking price before the latest cut, and when it was cut.
  add column if not exists previous_price integer check (previous_price is null or previous_price > 0),
  add column if not exists price_reduced_at timestamptz;

-- Matching counts only homes buyers can still go for: a sold or withdrawn
-- listing reaches nobody. Same shape as before, so callers don't change.
create or replace function agent_listing_reach()
returns table (listing_id uuid, matching integer, sent integer)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    case when l.market_status in ('available', 'under_offer') then
      (select count(distinct m.user_id)::integer
         from match_buyer_searches(l.postcode, l.price, l.bedrooms, l.property_type, l.has_garden) m
         where m.user_id <> l.agent_id)
    else 0 end,
    (select count(*)::integer from listing_sends s where s.listing_id = l.id)
  from agent_listings l
  where l.agent_id = auth.uid();
$$;
revoke all on function agent_listing_reach() from public, anon;
grant execute on function agent_listing_reach() to authenticated;

-- Check: every listing starts as For sale.
select market_status, count(*) from agent_listings group by market_status;
