-- Run once in the Supabase SQL editor (after 033).
--
-- A 14-day free trial for estate agents a buyer invites. Safe to run more
-- than once.
--
-- Why: most homes buyers save are marketed by agents who aren't on
-- PropertySearch yet. The buyer is the best salesperson we have, so a buyer
-- can invite the agent, and an agent answering a buyer's viewing request
-- gets a "start free trial" link. Invited agents join without a branch code
-- and can take bookings for 14 days. After that they need a code (one seat on
-- their branch's code, migration 019), which keeps billing per branch.
--
-- 1. agents: trial_ends_at, referred_by_household, trial_emails_sent,
--    code_requested_at. A trial agent bills as a branch of one
--    ('agent:<user id>', migration 021), with plan 'trial'.
-- 2. agent_invites: single-use sign-up links (30 days), written only by
--    /api/agent-signup with the service role.
-- 3. agent_invite_optouts: addresses that asked never to get an invite.
-- 4. slot_blocked(): an agent whose trial ended (and who has no code) can't
--    take new bookings. Confirmed bookings stay and they can still log in.
--    Buyers who saved the home see no bookable times, so the app falls back
--    to the email viewing request (ViewingSlots -> ViewingRequest).
-- 5. Server-only helpers: convert_trial_agent (enter a code), claim/release
--    trial emails (jobs/agent_trial_emails.py), trial_booking_count.
-- 6. Admin: admin_trial_agents, admin_extend_trial, admin_make_trial_code.

-- 1. Trial columns on agents ------------------------------------------------------

alter table agents add column if not exists trial_ends_at timestamptz;
alter table agents add column if not exists referred_by_household uuid
  references households (id) on delete set null;
-- Which trial emails have gone ('day10', 'day13'), so each goes once.
alter table agents add column if not exists trial_emails_sent text[] not null default '{}';
-- When a trial agent last pressed "Request a code" (shown on /admin).
alter table agents add column if not exists code_requested_at timestamptz;

create index if not exists agents_on_trial on agents (trial_ends_at) where trial_ends_at is not null;

-- Trial branches show as 'trial' on /admin, so they don't count as pilots.
alter table branch_billing drop constraint if exists branch_billing_plan_check;
alter table branch_billing add constraint branch_billing_plan_check
  check (plan in ('pilot', 'paying', 'cancelled', 'trial'));

-- 2. Invites ------------------------------------------------------------------------

create table if not exists agent_invites (
  id uuid primary key default gen_random_uuid(),
  -- The private link: /agent?invite=<token>.
  token uuid not null unique default gen_random_uuid(),
  -- Null when the buyer had no email for the agent and sent the link
  -- themselves; the agent then types their own email when they sign up.
  email text check (email is null or (email = lower(email) and char_length(email) between 3 and 254)),
  agent_name text check (char_length(agent_name) <= 100),
  invited_by_user uuid references auth.users (id) on delete set null,
  household_id uuid not null references households (id) on delete cascade,
  property_id uuid references properties (id) on delete set null,
  viewing_request_id uuid references viewing_requests (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  emailed_at timestamptz,
  used_at timestamptz,
  used_by uuid references auth.users (id) on delete set null
);

-- One unused invite per household and address. An expired one is renewed
-- rather than duplicated (the API does that).
create unique index if not exists agent_invites_one_open
  on agent_invites (household_id, lower(email)) where used_at is null and email is not null;
create index if not exists agent_invites_household on agent_invites (household_id, created_at desc);
create index if not exists agent_invites_email on agent_invites (lower(email), created_at desc);
create index if not exists agent_invites_request on agent_invites (viewing_request_id)
  where viewing_request_id is not null;

alter table agent_invites enable row level security;
-- No policies: only the API (service role) reads or writes it.

-- 3. Opt-outs -------------------------------------------------------------------------

create table if not exists agent_invite_optouts (
  email text primary key check (email = lower(email) and char_length(email) <= 254),
  created_at timestamptz not null default now()
);

alter table agent_invite_optouts enable row level security;
-- No policies: only the API (service role) reads or writes it.

-- 4. Expired trials can't take new bookings -------------------------------------------
-- Copied from 033 with one new condition (marked below).

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
        -- The agent is off that day (any slot, including ones added by hand).
        or exists (
          select 1
          from agent_time_off t
          where t.agent_id = s.agent_id
            and (s.starts_at at time zone 'Europe/London')::date between t.starts_on and t.ends_on
        )
        -- New in 034: the agent's free trial has ended and they have no
        -- branch code yet.
        or exists (
          select 1
          from agents ta
          where ta.user_id = s.agent_id
            and ta.trial_ends_at is not null
            and ta.trial_ends_at < now()
            and ta.signup_code is null
        )
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

-- 5. Server-only helpers ----------------------------------------------------------------

-- A trial (or code-less) agent enters a branch code: takes one seat with
-- claim_agent_code (the same as sign-up), then moves the agent onto that
-- branch and ends the trial, in one transaction. Listings and bookings are
-- untouched. Returns the agency, or null if the agent already has a code or
-- the code is wrong, off or full.
create or replace function convert_trial_agent(p_agent uuid, p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_agency text;
  v_branch text;
begin
  perform 1 from agents where user_id = p_agent and signup_code is null for update;
  if not found then
    return null;
  end if;
  v_agency := claim_agent_code(v_code);
  if v_agency is null then
    return null;
  end if;
  select branch into v_branch from agent_invite_codes where code = v_code;
  update agents
     set signup_code = v_code,
         agency = v_agency,
         branch = coalesce(v_branch, branch),
         trial_ends_at = null
   where user_id = p_agent;
  -- They're billed with their branch now: drop the one-person trial row so
  -- the admin billing list doesn't show a ghost branch.
  delete from branch_billing
   where branch_key = 'agent:' || p_agent::text and plan = 'trial';
  return v_agency;
end;
$$;

revoke all on function convert_trial_agent(uuid, text) from public, anon, authenticated;
grant execute on function convert_trial_agent(uuid, text) to service_role;

-- Confirmed viewings booked with an agent since they joined (the trial).
create or replace function trial_booking_count(p_agent uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from viewing_bookings b
  join viewing_slots s on s.id = b.slot_id
  join agents a on a.user_id = s.agent_id
  where s.agent_id = p_agent
    and b.status = 'confirmed'
    and b.created_at >= a.created_at;
$$;

revoke all on function trial_booking_count(uuid) from public, anon, authenticated;
grant execute on function trial_booking_count(uuid) to service_role;

-- The daily trial email job claims an email before sending (true: this run
-- sends it), and gives the claim back if the send fails.
create or replace function claim_trial_email(p_agent uuid, p_key text)
returns boolean
language sql
security definer
set search_path = public
as $$
  with claimed as (
    update agents
       set trial_emails_sent = array_append(trial_emails_sent, p_key)
     where user_id = p_agent
       and trial_ends_at is not null
       and not (p_key = any (trial_emails_sent))
    returning 1
  )
  select exists (select 1 from claimed);
$$;

create or replace function release_trial_email(p_agent uuid, p_key text)
returns void
language sql
security definer
set search_path = public
as $$
  update agents set trial_emails_sent = array_remove(trial_emails_sent, p_key) where user_id = p_agent;
$$;

revoke all on function claim_trial_email(uuid, text) from public, anon, authenticated;
grant execute on function claim_trial_email(uuid, text) to service_role;
revoke all on function release_trial_email(uuid, text) from public, anon, authenticated;
grant execute on function release_trial_email(uuid, text) to service_role;

-- 6. Admin -------------------------------------------------------------------------------

drop function if exists admin_trial_agents();
create function admin_trial_agents()
returns table (
  user_id uuid,
  name text,
  agency text,
  branch text,
  email text,
  phone text,
  created_at timestamptz,
  trial_ends_at timestamptz,
  referred_by_household uuid,
  code_requested_at timestamptz,
  listings integer,
  bookings integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return query
    select a.user_id, a.name, a.agency, a.branch, a.email, a.phone, a.created_at,
           a.trial_ends_at, a.referred_by_household, a.code_requested_at,
           (select count(*)::integer from agent_listings l where l.agent_id = a.user_id and l.is_active),
           trial_booking_count(a.user_id)
    from agents a
    where a.trial_ends_at is not null and a.signup_code is null
    order by a.trial_ends_at;
end;
$$;

revoke all on function admin_trial_agents() from public, anon;
grant execute on function admin_trial_agents() to authenticated;

-- 14 more days from today (or from the current end, if that's later). The
-- reminder emails can go again for the new end date.
create or replace function admin_extend_trial(p_agent uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_end timestamptz;
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  update agents
     set trial_ends_at = greatest(trial_ends_at, now()) + interval '14 days',
         trial_emails_sent = '{}'
   where user_id = p_agent and trial_ends_at is not null and signup_code is null
  returning trial_ends_at into v_end;
  if v_end is null then
    raise exception 'not a trial agent' using errcode = '22023';
  end if;
  return v_end;
end;
$$;

revoke all on function admin_extend_trial(uuid) from public, anon;
grant execute on function admin_extend_trial(uuid) to authenticated;

-- Make a branch code for a trial agent and put them on it (the same as them
-- entering it). The site then emails them the code. Returns the new code.
create or replace function admin_make_trial_code(
  p_agent uuid, p_agency text, p_branch text, p_seats integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if not exists (select 1 from agents where user_id = p_agent and signup_code is null) then
    raise exception 'this agent already has a branch code' using errcode = '22023';
  end if;
  v_code := admin_create_agent_code(p_agency, p_branch, p_seats, 'made from a free trial');
  if convert_trial_agent(p_agent, v_code) is null then
    -- Rolls back the new code too.
    raise exception 'could not put the agent on the new code' using errcode = '22023';
  end if;
  return v_code;
end;
$$;

revoke all on function admin_make_trial_code(uuid, text, text, integer) from public, anon;
grant execute on function admin_make_trial_code(uuid, text, text, integer) to authenticated;

-- Check: both counts start at 0.
select (select count(*) from agents where trial_ends_at is not null) as trial_agents,
       (select count(*) from agent_invites) as invites;
