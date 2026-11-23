-- Run once in the Supabase SQL editor.
--
-- 1. Agent profiles can only be created by the server, with a branch code.
--    Until now the own_agent policy let any signed-in account insert its own
--    agents row, so a buyer could become an agent with no code, no seat and
--    no branch billing. Agents can still read and update their own profile;
--    creating one goes through /api/agent-signup (service role).
--
-- 2. Sold STC and Off market homes stop offering viewing times. Weekly-hours
--    slots for them are removed, and the booking pages hide their times
--    (frontend/api/listing-viewings.js, available_viewings below).

-- 1. ------------------------------------------------------------------------

drop policy if exists own_agent on agents;
drop policy if exists own_agent_read on agents;
drop policy if exists own_agent_update on agents;

create policy own_agent_read on agents for select to authenticated
  using (user_id = auth.uid());

create policy own_agent_update on agents for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 2. ------------------------------------------------------------------------
-- Same functions as 022 with one change each: only homes that are For sale
-- or Under offer.

-- Weekly hours only make times for homes still on the market. When a home
-- goes back on the market, the next sync adds its times again.
create or replace function pattern_wanted_slots(p_agent uuid)
returns table (listing_id uuid, starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with av as (
    select * from agent_availability where agent_id = p_agent and enabled
  ),
  days as (
    select d::date as day
    from av, generate_series(
      (now() at time zone 'Europe/London')::date,
      (now() at time zone 'Europe/London')::date + av.days_ahead,
      interval '1 day') d
  ),
  times as (
    select ((dd.day + h.starts + make_interval(mins => k * av.slot_minutes)) at time zone 'Europe/London') as starts_at,
           av.slot_minutes
    from days dd
    cross join av
    join agent_hours h on h.agent_id = p_agent and h.weekday = extract(isodow from dd.day)
    cross join lateral generate_series(
      0, (extract(epoch from (h.ends - h.starts)) / 60)::int / av.slot_minutes - 1) k
    where not exists (
      select 1 from agent_time_off t
      where t.agent_id = p_agent and dd.day between t.starts_on and t.ends_on
    )
  )
  select l.id, t.starts_at, t.starts_at + make_interval(mins => t.slot_minutes)
  from times t
  join agent_listings l on l.agent_id = p_agent and l.is_active and l.auto_times
    and l.market_status in ('available', 'under_offer')
  where t.starts_at > now();
$$;

revoke all on function pattern_wanted_slots(uuid) from public, anon, authenticated;

-- Viewing times buyers see in the app.
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
  select * from (
    select
      p.id as property_id,
      s.id as slot_id,
      l.id as listing_id,
      s.starts_at,
      s.ends_at,
      s.capacity,
      (select count(*)::int from viewing_bookings b
        where b.slot_id = s.id and b.status = 'confirmed') as booked,
      (select b.id from viewing_bookings b
        where b.slot_id = s.id and b.status = 'confirmed' and b.buyer_id = auth.uid()
        limit 1) as my_booking_id,
      a.name as agent_name,
      a.agency,
      a.branch,
      l.notes as listing_notes
    from properties p
    join agent_listings l
      on l.listing_key = listing_key(p.listing_url) and l.is_active
    join agents a on a.user_id = l.agent_id
    join viewing_slots s
      on s.listing_id = l.id and s.cancelled_at is null and s.starts_at > now()
    where p.household_id = current_household_id()
  ) v
  -- Their own booking always shows (so they can see or cancel it); free
  -- times only while the home is on the market.
  where v.my_booking_id is not null
     or (not slot_blocked(v.slot_id)
         and exists (select 1 from agent_listings l2
                     where l2.id = v.listing_id and l2.market_status in ('available', 'under_offer')))
  order by v.starts_at;
$$;

revoke all on function available_viewings() from public, anon;
grant execute on function available_viewings() to authenticated;

-- Booking: a sold or withdrawn home can't be booked, however the buyer got
-- to the time.
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
  select * into s from viewing_slots where id = p_slot;
  if not found then
    raise exception 'SLOT_GONE';
  end if;

  perform 1 from agents where user_id = s.agent_id for no key update;
  select * into s from viewing_slots where id = p_slot for update;

  if not found or s.cancelled_at is not null then
    raise exception 'SLOT_GONE';
  end if;

  if exists (
    select 1 from agent_listings l
    where l.id = s.listing_id and l.market_status in ('sold_stc', 'off_market')
  ) then
    raise exception 'LISTING_CLOSED';
  end if;

  if s.starts_at <= now() then
    raise exception 'SLOT_PAST';
  end if;

  if exists (
    select 1
    from viewing_bookings b
    join viewing_slots other on other.id = b.slot_id
    where b.status = 'confirmed'
      and other.listing_id = s.listing_id
      and other.cancelled_at is null
      and other.starts_at > now()
      and (
        (p_buyer is not null and b.buyer_id = p_buyer)
        or lower(b.buyer_email) = lower(p_email)
      )
  ) then
    raise exception 'ALREADY_BOOKED';
  end if;

  select count(*) into taken
  from viewing_bookings
  where slot_id = p_slot and status = 'confirmed';

  if taken >= s.capacity or slot_blocked(p_slot) then
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

-- Tidy up: free weekly-hours times on homes already sold or withdrawn.
-- (Only ones nobody has ever booked, so no booking history is touched.)
delete from viewing_slots s
using agent_listings l
where s.listing_id = l.id
  and l.market_status in ('sold_stc', 'off_market')
  and s.from_pattern
  and s.starts_at > now()
  and s.cancelled_at is null
  and not exists (select 1 from viewing_bookings b where b.slot_id = s.id);

-- Check
select policyname, cmd from pg_policies where tablename = 'agents' order by policyname;
