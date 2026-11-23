-- Run once in the Supabase SQL editor (after 029).
--
-- 1. Buyers choose, agent by agent, what each one gets:
--      share_info  - sees their buying position, proof and search status
--      send_homes  - can send them new homes
--    Both start on. The agent still sees a booking or offer itself (they need
--    it to show the home); only the extras stop.
-- 2. Agents see roughly how much time PropertySearch saved them: bookings with
--    no phone call, homes sent to matching buyers, one-tap offer answers,
--    cancellations handled, and calls avoided to buyers who'd stopped looking.
--    Built from what's already recorded, plus agent_activity for the one
--    thing that isn't (buyers skipped). The minutes are stated estimates.

-- 1. Buyer controls, per agent ------------------------------------------------

create table if not exists buyer_agent_prefs (
  household_id uuid not null references households (id) on delete cascade,
  agent_id uuid not null references agents (user_id) on delete cascade,
  share_info boolean not null default true,
  send_homes boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (household_id, agent_id)
);

alter table buyer_agent_prefs enable row level security;

drop policy if exists household_agent_prefs on buyer_agent_prefs;
create policy household_agent_prefs on buyer_agent_prefs for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- Buyers (user ids) whose household told this agent to stop sending homes.
create or replace function buyers_blocking_agent(p_agent uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id
  from buyer_agent_prefs p
  join household_members m on m.household_id = p.household_id
  where p.agent_id = p_agent and not p.send_homes;
$$;

revoke all on function buyers_blocking_agent(uuid) from public, anon, authenticated;
grant execute on function buyers_blocking_agent(uuid) to service_role;

-- Buyers the calling agent deals with (017), minus households that stopped
-- sharing with this agent. Positions, proof documents and search status all
-- go through this, so one switch hides all three.
create or replace function agent_buyer_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select ids.id
  from (
    select b.buyer_id as id
    from viewing_bookings b
    join viewing_slots s on s.id = b.slot_id
    where s.agent_id = auth.uid() and b.buyer_id is not null
    union
    select o.reported_by
    from offers o
    join agent_listings l on l.id = o.agent_listing_id
    where l.agent_id = auth.uid() and o.reported_by is not null
  ) ids
  where not exists (
    select 1
    from household_members m
    join buyer_agent_prefs p on p.household_id = m.household_id
    where m.user_id = ids.id and p.agent_id = auth.uid() and not p.share_info
  );
$$;

-- Matching buyers per listing (024), without those who blocked this agent.
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
         where m.user_id <> l.agent_id
           and m.user_id not in (select buyers_blocking_agent(l.agent_id)))
    else 0 end,
    (select count(*)::integer from listing_sends s where s.listing_id = l.id)
  from agent_listings l
  where l.agent_id = auth.uid();
$$;
revoke all on function agent_listing_reach() from public, anon;
grant execute on function agent_listing_reach() to authenticated;

-- Auto-send to a new search (027), without agents the buyer blocked.
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
    and s.user_id not in (select buyers_blocking_agent(l.agent_id))
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

-- The agents a household deals with, for Settings: anyone who sent them a
-- home, took a booking or had an offer, and what each one may do.
create or replace function my_agents()
returns table (
  agent_id uuid, name text, agency text, branch text,
  homes_sent integer, viewings integer, offers integer, last_contact timestamptz,
  share_info boolean, send_homes boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select current_household_id() as hid),
  members as (select user_id from household_members, me where household_id = me.hid),
  contact as (
    select l.agent_id, 'send' as kind, s.sent_at as at
    from listing_sends s join agent_listings l on l.id = s.listing_id
    where s.user_id in (select user_id from members)
    union all
    select vs.agent_id, 'viewing', b.created_at
    from viewing_bookings b join viewing_slots vs on vs.id = b.slot_id
    where b.buyer_id in (select user_id from members)
    union all
    select l.agent_id, 'offer', o.reported_at
    from offers o join agent_listings l on l.id = o.agent_listing_id, me
    where o.household_id = me.hid
  )
  select
    a.user_id, a.name, a.agency, a.branch,
    count(*) filter (where c.kind = 'send')::integer,
    count(*) filter (where c.kind = 'viewing')::integer,
    count(*) filter (where c.kind = 'offer')::integer,
    max(c.at),
    coalesce(bool_and(p.share_info), true),
    coalesce(bool_and(p.send_homes), true)
  from contact c
  join agents a on a.user_id = c.agent_id
  cross join me
  left join buyer_agent_prefs p on p.agent_id = a.user_id and p.household_id = me.hid
  group by a.user_id, a.name, a.agency, a.branch
  order by max(c.at) desc;
$$;

revoke all on function my_agents() from public, anon;
grant execute on function my_agents() to authenticated;

-- 2. Time saved ---------------------------------------------------------------

-- Things worth counting that aren't stored anywhere else. Service role only.
create table if not exists agent_activity (
  id bigint generated always as identity primary key,
  agent_id uuid not null references agents (user_id) on delete cascade,
  -- One row per listing and kind, so sending a listing twice doesn't count
  -- the same buyers twice (api/send-listing.js keeps the highest count).
  listing_id uuid not null references agent_listings (id) on delete cascade,
  kind text not null check (kind in ('buyers_skipped')),
  count integer not null default 1 check (count > 0),
  created_at timestamptz not null default now(),
  unique (listing_id, kind)
);
create index if not exists agent_activity_agent_idx on agent_activity (agent_id, created_at);
alter table agent_activity enable row level security;

-- Buyers a listing would have reached but for their choice: paused, found
-- somewhere (029), or stopped this agent sending homes. Each is a call or
-- email the agent no longer wastes.
--
-- The matching rules move into match_buyer_searches_any (every buyer, any
-- status); match_buyer_searches keeps its signature and adds 029's "still
-- looking" rule on top, so the two can't drift apart.
create or replace function match_buyer_searches_any(
  p_postcode text,
  p_price integer,
  p_bedrooms integer,
  p_property_type text,
  p_has_garden boolean
)
returns table (search_id uuid, user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.user_id
  from buyer_searches s,
       (select postcode_district(p_postcode) as d,
               upper(regexp_replace(coalesce(p_postcode, ''), '\s', '', 'g')) as full_pc) pc
       left join lateral (
         select l.lat, l.lng, (l.postcode = pc.d) as is_district
         from postcode_locations l
         where l.postcode in (pc.full_pc, pc.d)
         order by (l.postcode = pc.d)
         limit 1
       ) loc on true
  where s.is_active
    and pc.d is not null
    and (
      s.areas && array[pc.d, postcode_area(pc.d)]
      or (s.radius_m is not null and loc.lat is not null
          and distance_m(loc.lat, loc.lng, s.center_lat, s.center_lng)
              <= s.radius_m + case when loc.is_district then 1000 else 0 end)
      or (s.polygon is not null and loc.lat is not null
          and distance_to_polygon_m(loc.lat, loc.lng, s.polygon)
              <= case when loc.is_district then 1000 else 0 end)
    )
    and (s.min_price is null or p_price is null or p_price >= s.min_price)
    and (s.max_price is null or p_price is null or p_price <= s.max_price)
    and (s.min_bedrooms is null or p_bedrooms is null or p_bedrooms >= s.min_bedrooms)
    and (s.property_types is null or p_property_type is null
         or p_property_type = any (s.property_types))
    and (not s.must_have_garden or coalesce(p_has_garden, false));
$$;

revoke all on function match_buyer_searches_any(text, integer, integer, text, boolean) from public, anon, authenticated;
grant execute on function match_buyer_searches_any(text, integer, integer, text, boolean) to service_role;

create or replace function match_buyer_searches(
  p_postcode text,
  p_price integer,
  p_bedrooms integer,
  p_property_type text,
  p_has_garden boolean
)
returns table (search_id uuid, user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select m.search_id, m.user_id
  from match_buyer_searches_any(p_postcode, p_price, p_bedrooms, p_property_type, p_has_garden) m
  where not exists (
    select 1
    from household_members hm
    join households h on h.id = hm.household_id
    where hm.user_id = m.user_id and not household_is_searching(h)
  );
$$;

revoke all on function match_buyer_searches(text, integer, integer, text, boolean) from public, anon, authenticated;
grant execute on function match_buyer_searches(text, integer, integer, text, boolean) to service_role;

create or replace function buyers_skipped_for_listing(p_listing uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with l as (select * from agent_listings where id = p_listing),
  everyone as (
    select distinct m.user_id
    from l, match_buyer_searches_any(l.postcode, l.price, l.bedrooms, l.property_type, l.has_garden) m
    where m.user_id <> l.agent_id
  ),
  reachable as (
    select distinct m.user_id
    from l, match_buyer_searches(l.postcode, l.price, l.bedrooms, l.property_type, l.has_garden) m
    where m.user_id not in (select buyers_blocking_agent(l.agent_id))
  )
  select count(*)::integer
  from everyone e
  where e.user_id not in (select user_id from reachable);
$$;

revoke all on function buyers_skipped_for_listing(uuid) from public, anon, authenticated;
grant execute on function buyers_skipped_for_listing(uuid) to service_role;

-- The calling agent's time saved since p_since: one row per kind, with the
-- count and the minutes it's estimated to have saved.
create or replace function agent_time_saved(p_since timestamptz)
returns table (kind text, count integer, minutes integer)
language sql
stable
security definer
set search_path = public
as $$
  with est(kind, each_min) as (values
    ('bookings', 10),        -- a viewing booked online, not on the phone
    ('cancellations', 5),    -- buyer cancelled: slot freed and everyone told
    ('homes_sent', 2),       -- a new home sent to a buyer who fits it
    ('offers_answered', 5),  -- an accepted offer confirmed with one tap
    ('buyers_skipped', 3)    -- not chasing a buyer who'd stopped looking
  ),
  counts(kind, n) as (
    select 'bookings', count(*)::integer
    from viewing_bookings b join viewing_slots s on s.id = b.slot_id
    where s.agent_id = auth.uid() and b.created_at >= p_since
    union all
    select 'cancellations', count(*)::integer
    from viewing_bookings b join viewing_slots s on s.id = b.slot_id
    where s.agent_id = auth.uid() and b.cancelled_by = 'buyer' and b.cancelled_at >= p_since
    union all
    select 'homes_sent', count(*)::integer
    from listing_sends x join agent_listings l on l.id = x.listing_id
    where l.agent_id = auth.uid() and x.sent_at >= p_since
    union all
    select 'offers_answered', count(*)::integer
    from offers o join agent_listings l on l.id = o.agent_listing_id
    where l.agent_id = auth.uid() and o.agent_responded_at >= p_since
    union all
    select 'buyers_skipped', coalesce(sum(a.count), 0)::integer
    from agent_activity a
    where a.agent_id = auth.uid() and a.kind = 'buyers_skipped' and a.created_at >= p_since
  )
  select c.kind, c.n, c.n * e.each_min
  from counts c join est e using (kind);
$$;

revoke all on function agent_time_saved(timestamptz) from public, anon;
grant execute on function agent_time_saved(timestamptz) to authenticated;

-- Check: both tables exist and start empty.
select
  (select count(*) from buyer_agent_prefs) as agent_prefs,
  (select count(*) from agent_activity) as activity;
