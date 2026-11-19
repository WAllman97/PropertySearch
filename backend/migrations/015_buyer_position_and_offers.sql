-- Buyer "ready to proceed" position and the "offer accepted" step.
-- Run once in the Supabase SQL editor.
--
-- buyer_positions: what a household says about its ability to buy (budget,
-- mortgage agreement, chain). Agents see it on viewings booked with them,
-- labelled as the buyer's own declaration, unless the household turns
-- sharing off.
--
-- offers: a buyer reports "our offer was accepted". When the home is one of
-- an agent's listings on PropertySearch, the agent is asked to confirm it;
-- only an agent-confirmed offer counts as verified. Offers on homes with no
-- agent here stay "unverified" (Land Registry sale records can confirm them
-- later). Written only through /api/offers (service role).

-- 1. Buying position (one per household) ---------------------------------------

create table if not exists buyer_positions (
  household_id uuid primary key references households (id) on delete cascade
    default current_household_id(),
  max_budget integer check (max_budget > 0 and max_budget < 100000000),
  deposit integer check (deposit >= 0 and deposit < 100000000),
  buying_with text check (buying_with in ('cash', 'mortgage')),
  -- none: not started; aip: agreement in principle; offer: full mortgage offer
  mortgage_status text check (mortgage_status in ('none', 'aip', 'offer')),
  aip_amount integer check (aip_amount > 0 and aip_amount < 100000000),
  aip_lender text check (char_length(aip_lender) <= 100),
  aip_expires date,
  selling_status text check (selling_status in
    ('first_time', 'nothing_to_sell', 'sold_stc', 'on_market', 'not_listed')),
  solicitor_ready boolean not null default false,
  move_timeframe text check (move_timeframe in ('asap', '3_months', '6_months', 'flexible')),
  share_with_agents boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null default auth.uid()
);

alter table buyer_positions enable row level security;

drop policy if exists household_access on buyer_positions;
create policy household_access on buyer_positions
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- Proceedable: can buy now. Cash, or a mortgage with at least an agreement in
-- principle that hasn't expired, AND no home to sell first (or it's sold).
create or replace function position_is_proceedable(p buyer_positions)
returns boolean
language sql
stable
as $$
  select
    (p.buying_with = 'cash'
      or (p.buying_with = 'mortgage'
          and p.mortgage_status in ('aip', 'offer')
          and (p.aip_expires is null or p.aip_expires >= current_date)))
    and p.selling_status in ('first_time', 'nothing_to_sell', 'sold_stc');
$$;

-- 2. Offers --------------------------------------------------------------------

create table if not exists offers (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  property_id uuid not null references properties (id) on delete cascade,
  agent_listing_id uuid references agent_listings (id) on delete set null,
  amount integer not null check (amount > 0 and amount < 100000000),
  reported_by uuid references auth.users (id) on delete set null,
  reported_at timestamptz not null default now(),
  -- awaiting_agent: the listing's agent hasn't answered yet
  -- confirmed / disputed: the agent's answer
  -- unverified: no agent on PropertySearch to ask
  -- withdrawn: the buyer took it back (fell through, typo, ...)
  status text not null default 'awaiting_agent'
    check (status in ('awaiting_agent', 'confirmed', 'disputed', 'unverified', 'withdrawn')),
  agent_responded_at timestamptz,
  withdrawn_at timestamptz
);

-- One live offer per saved home.
create unique index if not exists offers_one_live_per_property
  on offers (property_id) where status <> 'withdrawn';
create index if not exists offers_agent_listing_idx on offers (agent_listing_id);

alter table offers enable row level security;

-- Households read their own; all writes go through /api/offers.
drop policy if exists household_read on offers;
create policy household_read on offers
  for select to authenticated
  using (household_id = current_household_id());

-- What an agent may see about a buyer: only for buyers with a confirmed
-- viewing or an offer on one of the calling agent's listings, and only if
-- their household shares it.
create or replace function agent_buyer_positions()
returns table (
  buyer_id uuid,
  proceedable boolean,
  max_budget integer,
  buying_with text,
  mortgage_status text,
  aip_amount integer,
  aip_lender text,
  aip_expires date,
  selling_status text,
  solicitor_ready boolean,
  move_timeframe text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with my_buyers as (
    select b.buyer_id
    from viewing_bookings b
    join viewing_slots s on s.id = b.slot_id
    where s.agent_id = auth.uid() and b.buyer_id is not null
    union
    select o.reported_by
    from offers o
    join agent_listings l on l.id = o.agent_listing_id
    where l.agent_id = auth.uid() and o.reported_by is not null
  )
  select
    m.user_id,
    position_is_proceedable(p),
    p.max_budget, p.buying_with, p.mortgage_status, p.aip_amount, p.aip_lender,
    p.aip_expires, p.selling_status, p.solicitor_ready, p.move_timeframe, p.updated_at
  from my_buyers mb
  join household_members m on m.user_id = mb.buyer_id
  join buyer_positions p on p.household_id = m.household_id
  where p.share_with_agents;
$$;

-- Offers buyers have reported on the calling agent's listings.
create or replace function agent_offers()
returns table (
  offer_id uuid,
  listing_id uuid,
  address text,
  amount integer,
  status text,
  reported_at timestamptz,
  agent_responded_at timestamptz,
  buyer_id uuid,
  buyer_name text,
  buyer_email text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id, l.id, l.address, o.amount, o.status, o.reported_at, o.agent_responded_at,
    u.id, coalesce(u.raw_user_meta_data ->> 'name', split_part(u.email, '@', 1)), u.email
  from offers o
  join agent_listings l on l.id = o.agent_listing_id
  left join auth.users u on u.id = o.reported_by
  where l.agent_id = auth.uid() and o.status <> 'withdrawn'
  order by o.reported_at desc;
$$;

revoke all on function agent_buyer_positions() from public, anon;
grant execute on function agent_buyer_positions() to authenticated;
revoke all on function agent_offers() from public, anon;
grant execute on function agent_offers() to authenticated;

-- 3. Check -------------------------------------------------------------------

select
  (select count(*) from buyer_positions) as positions,
  (select count(*) from offers) as offers;
