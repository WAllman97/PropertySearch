-- Agent viewing slots: run once in the Supabase SQL editor, after 005.
--
-- Estate agents sign up at /agent (their own accounts, NOT household members,
-- so they can't see any household data). They add their listings by portal
-- URL and publish viewing times: private (one buyer) or open house (several).
-- Buyers see those times on the matching property cards and book instantly.
--
-- Agents manage their own rows directly (RLS below). Buyers never read agent
-- tables directly: they go through available_viewings(), and every booking or
-- cancellation goes through /api/viewings (service role), which also sends
-- the emails and keeps the app calendar in step.

-- Portal + listing id from a listing URL, e.g. 'rightmove:123456789'. Used to
-- match an agent's listing to the same home saved by buyers.
create or replace function listing_key(url text)
returns text
language sql
immutable
as $$
  select case
    when url ~* 'rightmove\.co\.uk/properties/[0-9]+'
      then 'rightmove:' || substring(url from '(?i)rightmove\.co\.uk/properties/([0-9]+)')
    when url ~* 'zoopla\.co\.uk/.*details/[0-9]+'
      then 'zoopla:' || substring(url from '(?i)zoopla\.co\.uk/.*details/([0-9]+)')
    when url ~* 'onthemarket\.com/details/[0-9]+'
      then 'onthemarket:' || substring(url from '(?i)onthemarket\.com/details/([0-9]+)')
    else null
  end;
$$;

create table if not exists agents (
  user_id uuid primary key references auth.users (id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  agency text not null check (length(agency) between 1 and 100),
  branch text check (length(branch) <= 100),
  phone text check (length(phone) <= 40),
  email text not null check (length(email) <= 254),
  created_at timestamptz not null default now()
);

create table if not exists agent_listings (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents (user_id) on delete cascade,
  listing_url text not null check (length(listing_url) <= 500),
  listing_key text generated always as (listing_key(listing_url)) stored,
  address text not null check (length(address) between 1 and 200),
  price integer check (price > 0),
  -- Shown to buyers, e.g. "Meet outside, street parking only".
  notes text check (length(notes) <= 500),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (listing_key is not null)
);

create unique index if not exists agent_listings_agent_key
  on agent_listings (agent_id, listing_key);
create index if not exists agent_listings_key on agent_listings (listing_key);

create table if not exists viewing_slots (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references agent_listings (id) on delete cascade,
  agent_id uuid not null references agents (user_id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- 1 = private viewing; more = open house with that many buyers.
  capacity smallint not null default 1 check (capacity between 1 and 30),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '4 hours')
);

create index if not exists viewing_slots_listing on viewing_slots (listing_id, starts_at);

create table if not exists viewing_bookings (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references viewing_slots (id) on delete cascade,
  buyer_id uuid not null references auth.users (id) on delete cascade,
  property_id uuid references properties (id) on delete set null,
  buyer_name text not null,
  buyer_email text not null,
  buyer_phone text,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  cancelled_by text check (cancelled_by in ('buyer', 'agent')),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz
);

create index if not exists viewing_bookings_slot on viewing_bookings (slot_id);
create index if not exists viewing_bookings_buyer on viewing_bookings (buyer_id);

-- RLS ------------------------------------------------------------------------

alter table agents enable row level security;
alter table agent_listings enable row level security;
alter table viewing_slots enable row level security;
alter table viewing_bookings enable row level security;

drop policy if exists own_agent on agents;
create policy own_agent on agents for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists own_listings on agent_listings;
create policy own_listings on agent_listings for all to authenticated
  using (agent_id = auth.uid())
  with check (agent_id = auth.uid());

-- Agents add and see their own slots. No client updates: moving a booked
-- viewing silently would strand buyers, so cancelling goes through the API.
-- Deleting is only allowed while nobody has booked.
drop policy if exists own_slots_select on viewing_slots;
create policy own_slots_select on viewing_slots for select to authenticated
  using (agent_id = auth.uid());

drop policy if exists own_slots_insert on viewing_slots;
create policy own_slots_insert on viewing_slots for insert to authenticated
  with check (
    agent_id = auth.uid()
    and starts_at > now()
    and exists (
      select 1 from agent_listings l
      where l.id = listing_id and l.agent_id = auth.uid()
    )
  );

drop policy if exists own_slots_delete on viewing_slots;
create policy own_slots_delete on viewing_slots for delete to authenticated
  using (
    agent_id = auth.uid()
    and not exists (
      select 1 from viewing_bookings b
      where b.slot_id = viewing_slots.id and b.status = 'confirmed'
    )
  );

-- Bookings are read-only to clients: the buyer sees their own, the agent sees
-- the ones on their slots. Writes only happen in /api/viewings.
drop policy if exists read_bookings on viewing_bookings;
create policy read_bookings on viewing_bookings for select to authenticated
  using (
    buyer_id = auth.uid()
    or exists (
      select 1 from viewing_slots s
      where s.id = viewing_bookings.slot_id and s.agent_id = auth.uid()
    )
  );

-- Buyer view -----------------------------------------------------------------

-- Upcoming open slots for every home the household has saved, with spaces
-- left and whether the caller is already booked. Household members only.
create or replace function available_viewings()
returns table (
  property_id uuid,
  slot_id uuid,
  listing_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  capacity smallint,
  booked integer,
  my_booking_id uuid,
  agent_name text,
  agency text,
  branch text,
  listing_notes text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    s.id,
    l.id,
    s.starts_at,
    s.ends_at,
    s.capacity,
    (select count(*)::int from viewing_bookings b
      where b.slot_id = s.id and b.status = 'confirmed'),
    (select b.id from viewing_bookings b
      where b.slot_id = s.id and b.status = 'confirmed' and b.buyer_id = auth.uid()
      limit 1),
    a.name,
    a.agency,
    a.branch,
    l.notes
  from properties p
  join agent_listings l
    on l.listing_key = listing_key(p.listing_url) and l.is_active
  join agents a on a.user_id = l.agent_id
  join viewing_slots s
    on s.listing_id = l.id and s.cancelled_at is null and s.starts_at > now()
  where is_household_member()
  order by s.starts_at;
$$;

revoke all on function available_viewings() from public, anon;
grant execute on function available_viewings() to authenticated;

-- Booking --------------------------------------------------------------------

-- Atomic booking: locks the slot so two buyers can't take the last space at
-- the same moment. Called only by /api/viewings with the service role.
create or replace function book_viewing(
  p_slot uuid,
  p_buyer uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_property uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s viewing_slots;
  taken integer;
  new_id uuid;
begin
  select * into s from viewing_slots where id = p_slot for update;

  if not found or s.cancelled_at is not null then
    raise exception 'SLOT_GONE';
  end if;

  if s.starts_at <= now() then
    raise exception 'SLOT_PAST';
  end if;

  if exists (
    select 1
    from viewing_bookings b
    join viewing_slots other on other.id = b.slot_id
    where b.buyer_id = p_buyer
      and b.status = 'confirmed'
      and other.listing_id = s.listing_id
      and other.cancelled_at is null
      and other.starts_at > now()
  ) then
    raise exception 'ALREADY_BOOKED';
  end if;

  select count(*) into taken
  from viewing_bookings
  where slot_id = p_slot and status = 'confirmed';

  if taken >= s.capacity then
    raise exception 'SLOT_FULL';
  end if;

  insert into viewing_bookings (slot_id, buyer_id, property_id, buyer_name, buyer_email, buyer_phone)
  values (p_slot, p_buyer, p_property, p_name, p_email, nullif(p_phone, ''))
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function book_viewing(uuid, uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function book_viewing(uuid, uuid, text, text, text, uuid) to service_role;
