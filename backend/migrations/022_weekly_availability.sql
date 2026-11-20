-- Weekly viewing availability: run in the Supabase SQL editor, after 021.
-- Safe to run again.
--
-- An agent sets their viewing hours once ("weekdays 5-7pm, Saturdays
-- 10am-1pm, 20-minute viewings") and every listing gets bookable slots from
-- it, kept topped up a few weeks ahead. Everything stays amendable:
--   * change the hours any time: free slots that no longer fit go, new ones
--     appear, booked viewings are never touched;
--   * time off (a day or a holiday) clears free slots in those days;
--   * a listing can opt out of the weekly hours (auto_times = false);
--   * any single free slot can be removed and won't come back;
--   * one-off times and open houses can still be added by hand.
--
-- The same hours are offered on every listing, so once a buyer books one
-- home, overlapping times on the agent's other homes stop being offered,
-- allowing travel time between homes (no double-booking the agent).

-- 1. Tables ------------------------------------------------------------------------

create table if not exists agent_availability (
  agent_id uuid primary key references agents (user_id) on delete cascade,
  enabled boolean not null default true,
  slot_minutes smallint not null default 20 check (slot_minutes in (15, 20, 30, 45, 60)),
  -- Gap needed between viewings at two different homes.
  travel_minutes smallint not null default 15 check (travel_minutes between 0 and 60),
  -- How far ahead slots are offered, and the shortest notice for a booking.
  days_ahead smallint not null default 14 check (days_ahead between 7 and 28),
  notice_hours smallint not null default 2 check (notice_hours between 0 and 72),
  updated_at timestamptz not null default now()
);

create table if not exists agent_hours (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents (user_id) on delete cascade,
  -- 1 = Monday ... 7 = Sunday. Times are UK local time.
  weekday smallint not null check (weekday between 1 and 7),
  starts time not null,
  ends time not null,
  check (ends > starts)
);

create index if not exists agent_hours_agent on agent_hours (agent_id, weekday);

create table if not exists agent_time_off (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents (user_id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  note text check (char_length(note) <= 100),
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check (ends_on - starts_on <= 366)
);

create index if not exists agent_time_off_agent on agent_time_off (agent_id, ends_on);

-- A listing can opt out of the weekly hours (times added by hand only).
alter table agent_listings add column if not exists auto_times boolean not null default true;

-- Made from the weekly hours (vs added by hand). A removed pattern slot is
-- kept with cancelled_at set so it isn't made again.
alter table viewing_slots add column if not exists from_pattern boolean not null default false;

create index if not exists viewing_slots_agent_time on viewing_slots (agent_id, starts_at);

alter table agent_availability enable row level security;
alter table agent_hours enable row level security;
alter table agent_time_off enable row level security;

drop policy if exists own_availability on agent_availability;
create policy own_availability on agent_availability for all to authenticated
  using (agent_id = auth.uid()) with check (agent_id = auth.uid());

drop policy if exists own_hours on agent_hours;
create policy own_hours on agent_hours for all to authenticated
  using (agent_id = auth.uid()) with check (agent_id = auth.uid());

drop policy if exists own_time_off on agent_time_off;
create policy own_time_off on agent_time_off for all to authenticated
  using (agent_id = auth.uid()) with check (agent_id = auth.uid());

-- 2. Is a slot still bookable? --------------------------------------------------------

-- True when the agent can't do this slot: they have a confirmed viewing on
-- another slot that overlaps it (plus travel time if it's a different home),
-- or it's a weekly-hours slot inside the agent's minimum notice.
create or replace function slot_blocked(p_slot uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from viewing_slots s
    left join agent_availability av on av.agent_id = s.agent_id
    where s.id = p_slot
      and (
        (s.from_pattern
          and s.starts_at < now() + make_interval(hours => coalesce(av.notice_hours, 0)))
        or exists (
          select 1
          from viewing_slots o
          join viewing_bookings b on b.slot_id = o.id and b.status = 'confirmed'
          where o.agent_id = s.agent_id
            and o.id <> s.id
            and o.cancelled_at is null
            and o.starts_at < s.ends_at + case when o.listing_id <> s.listing_id
                  then make_interval(mins => coalesce(av.travel_minutes, 0)) else interval '0' end
            and o.ends_at + case when o.listing_id <> s.listing_id
                  then make_interval(mins => coalesce(av.travel_minutes, 0)) else interval '0' end > s.starts_at
        )
      )
  );
$$;

revoke all on function slot_blocked(uuid) from public, anon, authenticated;
grant execute on function slot_blocked(uuid) to service_role;

-- Blocked slots on one listing, for the public booking link (/api/listing-viewings).
create or replace function listing_blocked_slots(p_listing uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id from viewing_slots s
  where s.listing_id = p_listing and s.cancelled_at is null and s.starts_at > now()
    and slot_blocked(s.id);
$$;

revoke all on function listing_blocked_slots(uuid) from public, anon, authenticated;
grant execute on function listing_blocked_slots(uuid) to service_role;

-- The caller's own blocked slots, so the portal can show them as taken.
create or replace function agent_blocked_slots()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id from viewing_slots s
  where s.agent_id = auth.uid() and s.cancelled_at is null and s.starts_at > now()
    and slot_blocked(s.id);
$$;

revoke all on function agent_blocked_slots() from public, anon;
grant execute on function agent_blocked_slots() to authenticated;

-- 3. Making slots from the weekly hours ----------------------------------------------

-- Every slot the agent's hours call for right now: each active listing that
-- uses the weekly hours, each day in range that isn't time off.
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
  where t.starts_at > now();
$$;

revoke all on function pattern_wanted_slots(uuid) from public, anon, authenticated;

-- Brings the agent's weekly-hours slots in line with their hours: removes
-- free ones that no longer fit, adds missing ones. Never touches a slot with a
-- confirmed booking, a slot added by hand, or one the agent removed.
-- Returns how many free weekly-hours slots there are after.
create or replace function sync_pattern_slots(p_agent uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  free_count integer;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (auth.uid() is null or auth.uid() <> p_agent) then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  -- One sync or booking at a time per agent.
  perform 1 from agents where user_id = p_agent for no key update;

  with w as materialized (select * from pattern_wanted_slots(p_agent))
  delete from viewing_slots s
  where s.agent_id = p_agent
    and s.from_pattern
    and s.cancelled_at is null
    and s.starts_at > now()
    and not exists (
      select 1 from viewing_bookings b where b.slot_id = s.id and b.status = 'confirmed'
    )
    and not exists (
      select 1 from w
      where w.listing_id = s.listing_id and w.starts_at = s.starts_at and w.ends_at = s.ends_at
    );

  insert into viewing_slots (listing_id, agent_id, starts_at, ends_at, capacity, from_pattern)
  select w.listing_id, p_agent, w.starts_at, w.ends_at, 1, true
  from pattern_wanted_slots(p_agent) w
  where not exists (
    select 1 from viewing_slots s
    where s.listing_id = w.listing_id
      and (
        -- Anything live already covering that time (a booked slot, a time
        -- added by hand, an open house).
        (s.cancelled_at is null and s.starts_at < w.ends_at and s.ends_at > w.starts_at)
        -- Or the agent removed this exact slot before.
        or (s.cancelled_at is not null and s.from_pattern and s.starts_at = w.starts_at)
      )
  );

  select count(*) into free_count
  from viewing_slots s
  where s.agent_id = p_agent and s.from_pattern and s.cancelled_at is null and s.starts_at > now()
    and not exists (select 1 from viewing_bookings b where b.slot_id = s.id and b.status = 'confirmed');
  return free_count;
end;
$$;

revoke all on function sync_pattern_slots(uuid) from public, anon;
grant execute on function sync_pattern_slots(uuid) to authenticated, service_role;

-- Daily top-up for every agent with weekly hours (run by the daily job).
create or replace function sync_all_pattern_slots()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
begin
  for r in select agent_id from agent_availability loop
    perform sync_pattern_slots(r.agent_id);
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function sync_all_pattern_slots() from public, anon, authenticated;
grant execute on function sync_all_pattern_slots() to service_role;

-- Saves the agent's weekly hours and settings in one go, then syncs.
-- p_hours: [{"weekday": 1, "starts": "17:00", "ends": "19:00"}, ...]
create or replace function agent_save_availability(
  p_enabled boolean,
  p_slot_minutes integer,
  p_travel_minutes integer,
  p_days_ahead integer,
  p_notice_hours integer,
  p_hours jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not exists (select 1 from agents where user_id = me) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 28 then
    raise exception 'hours must be a list (at most 28 periods)' using errcode = '22023';
  end if;

  insert into agent_availability (agent_id, enabled, slot_minutes, travel_minutes, days_ahead, notice_hours, updated_at)
  values (me, p_enabled, p_slot_minutes, p_travel_minutes, p_days_ahead, p_notice_hours, now())
  on conflict (agent_id) do update set
    enabled = excluded.enabled,
    slot_minutes = excluded.slot_minutes,
    travel_minutes = excluded.travel_minutes,
    days_ahead = excluded.days_ahead,
    notice_hours = excluded.notice_hours,
    updated_at = now();

  delete from agent_hours where agent_id = me;
  insert into agent_hours (agent_id, weekday, starts, ends)
  select me, (h ->> 'weekday')::smallint, (h ->> 'starts')::time, (h ->> 'ends')::time
  from jsonb_array_elements(p_hours) h;

  return sync_pattern_slots(me);
end;
$$;

revoke all on function agent_save_availability(boolean, integer, integer, integer, integer, jsonb) from public, anon;
grant execute on function agent_save_availability(boolean, integer, integer, integer, integer, jsonb) to authenticated;

-- Removes free slots the agent picks. Weekly-hours slots are marked removed
-- so they don't come back; slots added by hand are deleted. Booked slots are
-- left alone (cancelling those goes through /api/viewings, which emails the buyer).
create or replace function agent_remove_slots(p_slots uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  n integer := 0;
  m integer;
begin
  if me is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  update viewing_slots s set cancelled_at = now()
  where s.id = any (p_slots) and s.agent_id = me and s.from_pattern and s.cancelled_at is null
    and not exists (select 1 from viewing_bookings b where b.slot_id = s.id and b.status = 'confirmed');
  get diagnostics n = row_count;

  delete from viewing_slots s
  where s.id = any (p_slots) and s.agent_id = me and not s.from_pattern
    and not exists (select 1 from viewing_bookings b where b.slot_id = s.id and b.status = 'confirmed');
  get diagnostics m = row_count;

  return n + m;
end;
$$;

revoke all on function agent_remove_slots(uuid[]) from public, anon;
grant execute on function agent_remove_slots(uuid[]) to authenticated;

-- 4. Buyers only see slots the agent can still do --------------------------------------

-- Same as 013, without blocked slots (a buyer's own booking always shows).
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
  where v.my_booking_id is not null or not slot_blocked(v.slot_id)
  order by v.starts_at;
$$;

revoke all on function available_viewings() from public, anon;
grant execute on function available_viewings() to authenticated;

-- Same as 007, plus: one booking at a time per agent, and a slot the agent
-- can no longer do (clash or too short notice) can't be booked.
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

  -- Bookings for one agent go one at a time, so two buyers can't take
  -- clashing times at two homes at the same moment.
  perform 1 from agents where user_id = s.agent_id for no key update;
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

-- 5. Admin dashboard: weekly-hours slots aren't agent activity (replaces 021) -----------

create or replace function admin_metrics()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result json;
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  with
  hh as (
    select h.id, h.created_at
    from households h
    where not h.is_original
  ),
  members as (
    select m.household_id, m.user_id, u.last_sign_in_at
    from household_members m
    join hh on hh.id = m.household_id
    join auth.users u on u.id = m.user_id
  ),
  weeks as (
    select generate_series(
      date_trunc('week', now()) - interval '11 weeks',
      date_trunc('week', now()),
      interval '1 week'
    ) as week
  ),
  months as (
    select generate_series(
      date_trunc('month', now()) - interval '11 months',
      date_trunc('month', now()),
      interval '1 month'
    ) as month
  ),
  -- Households old enough to judge (7+ days), from the last 90 days.
  cohort as (
    select hh.id,
      (select count(*) from properties p
         where p.household_id = hh.id and p.created_at <= hh.created_at + interval '7 days') >= 3
      and exists (select 1 from buyer_searches s join members m on m.user_id = s.user_id
                  where m.household_id = hh.id and s.created_at <= hh.created_at + interval '7 days')
        as activated
    from hh
    where hh.created_at <= now() - interval '7 days'
      and hh.created_at > now() - interval '97 days'
  ),
  active_hh as (
    select distinct household_id from members where last_sign_in_at > now() - interval '7 days'
    union
    select p.household_id from properties p join hh on hh.id = p.household_id
      where p.created_at > now() - interval '7 days'
    union
    select o.household_id from offers o join hh on hh.id = o.household_id
      where o.reported_at > now() - interval '7 days'
    union
    select m.household_id from viewing_bookings b join members m on m.user_id = b.buyer_id
      where b.created_at > now() - interval '7 days'
  ),
  positions as (
    select p.*, position_is_proceedable(p) as proceedable
    from buyer_positions p join hh on hh.id = p.household_id
  ),
  -- Every viewing that came through the app: agents' slots booked by buyers
  -- in the app or by guests from a share link, and viewings agents requested
  -- through a buyer's booking page that the buyer accepted.
  viewings as (
    select b.created_at, case when b.buyer_id is null then 'guest' else 'app' end as source, s.agent_id
    from viewing_bookings b join viewing_slots s on s.id = b.slot_id
    where b.status = 'confirmed'
    union all
    select r.created_at, 'request', null
    from booking_requests r
    where r.kind = 'viewing' and r.status = 'accepted'
      and r.user_id not in (select m.user_id from household_members m join households h
                            on h.id = m.household_id where h.is_original)
  ),
  -- One row per agent login, with the branch it belongs to: its sign-up
  -- code, or (agents who joined before codes) a branch of its own.
  agent_stats as (
    select
      a.user_id, a.name, a.email, a.created_at,
      coalesce(a.signup_code, 'agent:' || a.user_id) as branch_key,
      (select count(*) from agent_listings l where l.agent_id = a.user_id and l.is_active) as listings,
      (select count(*) from viewing_slots s where s.agent_id = a.user_id and not s.from_pattern
         and s.created_at > now() - interval '30 days') as slots_30d,
      (select count(*) from viewings v where v.agent_id = a.user_id
         and v.created_at > now() - interval '30 days') as viewings_30d,
      (select count(*) from listing_sends ls join agent_listings l on l.id = ls.listing_id
         where l.agent_id = a.user_id and ls.sent_at > now() - interval '30 days') as sends_30d,
      greatest(
        (select max(l.created_at) from agent_listings l where l.agent_id = a.user_id),
        (select max(s.created_at) from viewing_slots s where s.agent_id = a.user_id and not s.from_pattern),
        (select av.updated_at from agent_availability av where av.agent_id = a.user_id),
        (select max(ls.sent_at) from listing_sends ls join agent_listings l on l.id = ls.listing_id
           where l.agent_id = a.user_id)
      ) as last_activity
    from agents a
  ),
  branch_keys as (
    select c.code as branch_key, c.code, c.agency, c.branch, c.max_uses as seats,
           c.created_at, c.is_active
    from agent_invite_codes c
    union all
    select 'agent:' || a.user_id, null, a.agency, a.branch, null, a.created_at, true
    from agents a
    where a.signup_code is null
  ),
  -- Pricing is per branch: one plan and fee per branch, however many people.
  agent_rows as (
    select
      k.branch_key, k.code, k.agency, k.branch, k.seats, k.is_active,
      coalesce(min(s.created_at), k.created_at) as created_at,
      count(s.user_id) as people,
      coalesce(json_agg(json_build_object('name', s.name, 'email', s.email)
                        order by s.created_at) filter (where s.user_id is not null), '[]'::json)
        as people_list,
      coalesce(sum(s.listings), 0) as listings,
      coalesce(sum(s.slots_30d), 0) as slots_30d,
      coalesce(sum(s.viewings_30d), 0) as viewings_30d,
      coalesce(sum(s.sends_30d), 0) as sends_30d,
      max(s.last_activity) as last_activity,
      coalesce(bb.plan, 'pilot') as plan, bb.monthly_fee, bb.paying_since
    from branch_keys k
    left join agent_stats s on s.branch_key = k.branch_key
    left join branch_billing bb on bb.branch_key = k.branch_key
    group by k.branch_key, k.code, k.agency, k.branch, k.seats, k.is_active, k.created_at,
             bb.plan, bb.monthly_fee, bb.paying_since
  ),
  -- Branches with at least one person signed up.
  live_branches as (
    select * from agent_rows where people > 0
  )
  select json_build_object(
    'generated_at', now(),
    'targets', (select coalesce(json_agg(t order by t.ends), '[]'::json) from admin_targets t),
    'buyers', json_build_object(
      'households', (select count(*) from hh),
      'new_by_week', (select json_agg(json_build_object('period', w.week,
          'value', (select count(*) from hh where date_trunc('week', hh.created_at) = w.week))
          order by w.week) from weeks w),
      'cohort_size', (select count(*) from cohort),
      'cohort_activated', (select count(*) from cohort where activated),
      'active_7d', (select count(*) from active_hh),
      'with_position', (select count(*) from positions),
      'proceedable', (select count(*) from positions where proceedable),
      'with_proof', (select count(*) from positions where proof_path is not null),
      'with_search', (select count(distinct m.household_id) from members m
                        join buyer_searches s on s.user_id = m.user_id)
    ),
    'viewings', json_build_object(
      'by_month', (select json_agg(json_build_object('period', mo.month,
          'value', (select count(*) from viewings v where date_trunc('month', v.created_at) = mo.month),
          'app', (select count(*) from viewings v where v.source = 'app' and date_trunc('month', v.created_at) = mo.month),
          'guest', (select count(*) from viewings v where v.source = 'guest' and date_trunc('month', v.created_at) = mo.month),
          'request', (select count(*) from viewings v where v.source = 'request' and date_trunc('month', v.created_at) = mo.month))
          order by mo.month) from months mo),
      'last_30d', (select count(*) from viewings where created_at > now() - interval '30 days')
    ),
    'offers', json_build_object(
      'by_month', (select json_agg(json_build_object('period', mo.month,
          'value', (select count(*) from offers o join hh on hh.id = o.household_id
                      where date_trunc('month', o.reported_at) = mo.month))
          order by mo.month) from months mo),
      'reported', (select count(*) from offers o join hh on hh.id = o.household_id
                     where o.status <> 'withdrawn'),
      'confirmed', (select count(*) from offers o join hh on hh.id = o.household_id
                      where o.status = 'confirmed'),
      'awaiting', (select count(*) from offers o join hh on hh.id = o.household_id
                     where o.status = 'awaiting_agent'),
      'disputed', (select count(*) from offers o join hh on hh.id = o.household_id
                     where o.status = 'disputed')
    ),
    'agents', json_build_object(
      'total', (select count(*) from live_branches),
      'people', (select count(*) from agents),
      'active_30d', (select count(*) from live_branches
                       where slots_30d > 0 or sends_30d > 0 or last_activity > now() - interval '30 days'),
      'paying', (select count(*) from live_branches where plan = 'paying'),
      'pilot', (select count(*) from live_branches where plan = 'pilot'),
      'cancelled', (select count(*) from live_branches where plan = 'cancelled'),
      'ever_paid', (select count(*) from branch_billing b
                      join live_branches l on l.branch_key = b.branch_key
                      where b.paying_since is not null),
      'mrr', (select coalesce(sum(monthly_fee), 0) from live_branches where plan = 'paying'),
      'list', (select coalesce(json_agg(r order by r.agency, r.branch, r.created_at), '[]'::json)
               from agent_rows r)
    )
  ) into result;

  return result;
end;
$$;

revoke all on function admin_metrics() from public, anon;
grant execute on function admin_metrics() to authenticated;

-- 6. Check ------------------------------------------------------------------------

select (select count(*) from agent_availability) as agents_with_weekly_hours,
       (select count(*) from viewing_slots where from_pattern) as weekly_hours_slots;
