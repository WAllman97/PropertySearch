-- Run once in the Supabase SQL editor (after 038). Safe to run more than once.
--
-- From the scaling review (docs/SCALING_REVIEW.md, 26 Nov 2026):
--
-- 1. cleanup_old_rows(): past viewing times nobody booked, and old rate-limit
--    rows, are deleted. Weekly hours make ~100 slots per listing and nothing
--    removed past ones, so the table would fill the free 500 MB database.
--    The hourly reminders job calls it (jobs/send_viewing_reminders.py).
--    Slots with any booking (even cancelled) are kept as history.
-- 2. slot_blocked(): the clash check only looks at the agent's slots near
--    the time in question, not their whole history. A slot is at most 4
--    hours and travel at most 60 minutes, so 5 hours either side is enough.
-- 3. Indexes on columns used to find rows when a household, home or user is
--    deleted (each delete otherwise scans the whole table), and for 1 and 2.

-- 1. Clean-up -------------------------------------------------------------------------

create index if not exists viewing_slots_ends on viewing_slots (ends_at);
create index if not exists api_usage_created on api_usage (created_at);

-- In batches, so a big first run doesn't hold locks for long. Returns how
-- many rows went, e.g. {"slots": 1200, "api_usage": 300}.
create or replace function cleanup_old_rows(p_batch integer default 5000)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slots integer := 0;
  v_usage integer := 0;
  n integer;
begin
  loop
    delete from viewing_slots s
    where s.id in (
      select o.id
      from viewing_slots o
      where o.ends_at < now() - interval '1 day'
        and not exists (select 1 from viewing_bookings b where b.slot_id = o.id)
      limit p_batch
    );
    get diagnostics n = row_count;
    v_slots := v_slots + n;
    exit when n < p_batch or v_slots >= p_batch * 20;
  end loop;

  -- Rate limits look back at most a day (_lib/household.js underRateLimit).
  delete from api_usage where created_at < now() - interval '2 days';
  get diagnostics v_usage = row_count;

  return jsonb_build_object('slots', v_slots, 'api_usage', v_usage);
end;
$$;

revoke all on function cleanup_old_rows(integer) from public, anon, authenticated;
grant execute on function cleanup_old_rows(integer) to service_role;

-- 2. Clash check, bounded in time (otherwise copied from 034) ------------------------

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
        -- The agent's free trial has ended and they have no branch code yet.
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
            -- New in 039: only slots that could overlap (uses the
            -- (agent_id, starts_at) index instead of the whole history).
            and o.starts_at > s.starts_at - interval '5 hours'
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

-- 3. Missing indexes ------------------------------------------------------------------

create index if not exists viewing_bookings_confirmed_slot
  on viewing_bookings (slot_id) where status = 'confirmed';
create index if not exists viewing_bookings_property on viewing_bookings (property_id);
create index if not exists viewing_feedback_property on viewing_feedback (property_id);
create index if not exists agent_invites_property on agent_invites (property_id);
create index if not exists booking_requests_property on booking_requests (property_id);
create index if not exists listing_sends_user on listing_sends (user_id);
create index if not exists offers_household on offers (household_id);
