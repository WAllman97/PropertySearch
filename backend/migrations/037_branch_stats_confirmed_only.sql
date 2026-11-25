-- Run once in the Supabase SQL editor (after 036).
--
-- The branch numbers card (branch_stats, migration 035) counted cancelled
-- bookings as bookings, so a branch's total (and its minutes saved) went up
-- when buyers cancelled. This re-creates branch_stats exactly as in 035,
-- counting confirmed bookings only. Safe to run more than once.

create or replace function branch_stats(p_since timestamptz)
returns table (
  agents integer,
  bookings integer,
  homes_sent integer,
  viewings_done integer,
  feedback_received integer,
  offers integer,
  minutes_saved integer
)
language sql
stable
security definer
set search_path = public
as $$
  with branch as (
    select a.user_id
    from agents a
    join agents me on me.user_id = auth.uid()
    where me.signup_code is not null and a.signup_code = me.signup_code
  ),
  bk as (
    select b.*, s.ends_at
    from viewing_bookings b
    join viewing_slots s on s.id = b.slot_id
    where s.agent_id in (select user_id from branch)
  ),
  n as (
    select
      (select count(*)::int from branch) as agents,
      (select count(*)::int from bk where bk.status = 'confirmed' and bk.created_at >= p_since) as bookings,
      (select count(*)::int from bk where bk.cancelled_by = 'buyer' and bk.cancelled_at >= p_since) as cancellations,
      (select count(*)::int from listing_sends x join agent_listings l on l.id = x.listing_id
        where l.agent_id in (select user_id from branch) and x.sent_at >= p_since) as homes_sent,
      (select count(*)::int from bk
        where bk.status = 'confirmed' and bk.buyer_id is not null
          and bk.ends_at >= p_since and bk.ends_at < now()) as viewings_done,
      (select count(*)::int from bk
        where bk.status = 'confirmed' and bk.buyer_id is not null
          and bk.ends_at >= p_since and bk.ends_at < now()
          and exists (select 1 from viewing_feedback f where f.booking_id = bk.id)) as feedback_received,
      (select count(*)::int from offers o join agent_listings l on l.id = o.agent_listing_id
        where l.agent_id in (select user_id from branch) and o.reported_at >= p_since
          and o.status <> 'withdrawn') as offers,
      (select count(*)::int from offers o join agent_listings l on l.id = o.agent_listing_id
        where l.agent_id in (select user_id from branch) and o.agent_responded_at >= p_since) as offers_answered,
      (select coalesce(sum(a.count), 0)::int from agent_activity a
        where a.agent_id in (select user_id from branch) and a.kind = 'buyers_skipped'
          and a.created_at >= p_since) as skipped
  )
  select agents, bookings, homes_sent, viewings_done, feedback_received, offers,
         bookings * 10 + cancellations * 5 + homes_sent * 2 + offers_answered * 5 + skipped * 3
  from n;
$$;

revoke all on function branch_stats(timestamptz) from public, anon;
grant execute on function branch_stats(timestamptz) to authenticated;

-- Check: the function now counts confirmed bookings only (expect true).
select pg_get_functiondef('branch_stats(timestamptz)'::regprocedure) like '%bk.status = ''confirmed'' and bk.created_at >= p_since%' as confirmed_only;
