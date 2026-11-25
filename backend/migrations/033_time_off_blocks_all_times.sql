-- Run once in the Supabase SQL editor (after 032).
--
-- Time off now blocks every viewing time on those days, not just the ones
-- made from the weekly hours. Before this, a time the agent added by hand
-- on a day off stayed bookable: sync_pattern_slots only removes weekly-hours
-- slots, and nothing else looked at agent_time_off.
--
-- slot_blocked() is the one check used by available_viewings, book_viewing,
-- listing_blocked_slots and agent_blocked_slots, so changing it covers all of
-- them. A slot is now also blocked when its London date falls inside one of
-- the agent's time-off ranges (starts_on..ends_on, inclusive).
--
-- Nothing is cancelled: confirmed bookings on those days stay as they are
-- (buyers still see their own booking); only new bookings are stopped.
-- Safe to run more than once.

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

-- Check: how many future live slots are now blocked by time off (any number is fine).
select count(*) as slots_blocked_by_time_off
from viewing_slots s
where s.cancelled_at is null and s.starts_at > now()
  and exists (select 1 from agent_time_off t
              where t.agent_id = s.agent_id
                and (s.starts_at at time zone 'Europe/London')::date between t.starts_on and t.ends_on);
