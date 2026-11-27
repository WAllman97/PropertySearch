-- Run once in the Supabase SQL editor (after 039). Safe to run more than once.
--
-- Monthly "what ViewPal did for you" report per branch (brief from 26 Nov).
--
-- 1. branch_report(branch, from, to): one branch's figures for a period, as
--    jsonb. A branch is a sign-up code, or 'agent:<id>' for an agent without
--    one (the same keys as branch_billing, migration 021). Totals only,
--    never per agent or per buyer. Service role only.
-- 2. my_branch_report(from, to): the same for the calling agent's branch,
--    for the dashboard card in the agent portal.
-- 3. branch_monthly_reports: one row per branch per month, claimed before
--    the email is sent (so a retry never sends twice). Branches with no
--    activity get a 'no_activity' row instead of an email: /admin lists
--    them as a churn risk. admin_branch_reports(month) reads it for /admin.
-- 4. email_preferences.monthly_report: agents can unsubscribe from it.
--
-- The email itself is built and sent by /api/agent-signup (actions
-- monthly_report_*, frontend/api/_lib/monthly-report.js), started by the
-- GitHub workflow monthly-value-report.yml on the 1st of each month.

-- 1. Figures for one branch ----------------------------------------------------------

create or replace function branch_report(p_branch text, p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with branch as (
    select a.user_id
    from agents a
    where coalesce(a.signup_code, 'agent:' || a.user_id) = p_branch
  ),
  bk as (
    select b.*, s.starts_at, s.ends_at
    from viewing_bookings b
    join viewing_slots s on s.id = b.slot_id
    where s.agent_id in (select user_id from branch)
  ),
  booked as (
    select * from bk
    where bk.status = 'confirmed' and bk.created_at >= p_from and bk.created_at < p_to
  ),
  -- Buyers (app accounts) who booked this month, and whether their household
  -- shares its buying position with agents (015) and with this branch (030).
  buyers as (
    select distinct m.household_id
    from booked
    join household_members m on m.user_id = booked.buyer_id
  ),
  ready as (
    select count(*)::int as households
    from buyers x
    join buyer_positions p on p.household_id = x.household_id
    where p.share_with_agents
      and (p.proof_path is not null
           or p.buying_with = 'cash'
           or (p.mortgage_status in ('aip', 'offer')
               and (p.aip_expires is null or p.aip_expires >= p_from::date)))
      and not exists (
        select 1 from buyer_agent_prefs ap
        where ap.household_id = x.household_id
          and ap.agent_id in (select user_id from branch)
          and not ap.share_info
      )
  ),
  n as (
    select
      (select count(*)::int from branch) as agents,
      (select count(*)::int from booked) as bookings,
      (select count(distinct coalesce(booked.buyer_id::text, lower(booked.buyer_email)))::int
         from booked) as buyers,
      (select households from ready) as buyers_ready,
      (select count(*)::int from bk
        where bk.status = 'confirmed' and bk.ends_at >= p_from and bk.ends_at < least(p_to, now()))
        as viewings_held,
      -- Cancelled by the buyer before the viewing started: the time was freed
      -- and everyone told without a call.
      (select count(*)::int from bk
        where bk.cancelled_by = 'buyer' and bk.cancelled_at >= p_from and bk.cancelled_at < p_to
          and bk.cancelled_at < bk.starts_at) as cancelled_with_notice,
      (select count(*)::int from viewing_feedback f
        join bk on bk.id = f.booking_id
        where f.created_at >= p_from and f.created_at < p_to) as feedback,
      (select count(*)::int from listing_sends x join agent_listings l on l.id = x.listing_id
        where l.agent_id in (select user_id from branch)
          and x.sent_at >= p_from and x.sent_at < p_to) as homes_sent,
      (select count(*)::int from offers o join agent_listings l on l.id = o.agent_listing_id
        where l.agent_id in (select user_id from branch)
          and o.reported_at >= p_from and o.reported_at < p_to
          and o.status <> 'withdrawn') as offers,
      (select count(*)::int from offers o join agent_listings l on l.id = o.agent_listing_id
        where l.agent_id in (select user_id from branch)
          and o.agent_responded_at >= p_from and o.agent_responded_at < p_to) as offers_answered,
      (select coalesce(sum(a.count), 0)::int from agent_activity a
        where a.agent_id in (select user_id from branch) and a.kind = 'buyers_skipped'
          and a.created_at >= p_from and a.created_at < p_to) as skipped,
      (select count(*)::int from agent_listings l
        where l.agent_id in (select user_id from branch) and l.is_active) as live_listings
  )
  select jsonb_build_object(
    'agents', agents,
    'bookings', bookings,
    'buyers', buyers,
    'buyers_ready', buyers_ready,
    'viewings_held', viewings_held,
    'cancelled_with_notice', cancelled_with_notice,
    'feedback', feedback,
    'homes_sent', homes_sent,
    'offers', offers,
    'offers_answered', offers_answered,
    'buyers_skipped', skipped,
    'live_listings', live_listings,
    -- The same estimates as agent_time_saved (030) and branch_stats (037).
    'minutes_saved', bookings * 10 + cancelled_with_notice * 5 + homes_sent * 2
                     + offers_answered * 5 + skipped * 3,
    'active', (bookings + viewings_held + cancelled_with_notice + feedback + homes_sent + offers) > 0
  )
  from n;
$$;

revoke all on function branch_report(text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function branch_report(text, timestamptz, timestamptz) to service_role;

-- 2. The calling agent's branch ------------------------------------------------------

create or replace function my_branch_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select branch_report(coalesce(a.signup_code, 'agent:' || a.user_id), p_from, p_to)
  from agents a
  where a.user_id = auth.uid();
$$;

revoke all on function my_branch_report(timestamptz, timestamptz) from public, anon;
grant execute on function my_branch_report(timestamptz, timestamptz) to authenticated;

-- 3. One row per branch per month ------------------------------------------------------

create table if not exists branch_monthly_reports (
  branch_key text not null check (char_length(branch_key) <= 60),
  -- First day of the month the report is about.
  month date not null check (extract(day from month) = 1),
  -- claimed: being sent now; sent; no_activity: nothing to report (churn
  -- risk, no email); no_recipients: nobody at the branch takes the email;
  -- failed: the send failed (the next run tries again).
  status text not null check (status in ('claimed', 'sent', 'no_activity', 'no_recipients', 'failed')),
  figures jsonb,
  recipients integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (branch_key, month)
);
create index if not exists branch_monthly_reports_month on branch_monthly_reports (month, status);

-- Server only (no policies).
alter table branch_monthly_reports enable row level security;

-- For /admin: every report row for a month, with the branch's name.
create or replace function admin_branch_reports(p_month date)
returns table (
  branch_key text,
  agency text,
  branch text,
  status text,
  figures jsonb,
  recipients integer,
  updated_at timestamptz
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
  select r.branch_key,
         coalesce(c.agency, a.agency),
         coalesce(c.branch, a.branch),
         r.status, r.figures, r.recipients, r.updated_at
  from branch_monthly_reports r
  left join agent_invite_codes c on c.code = r.branch_key
  left join agents a on 'agent:' || a.user_id = r.branch_key
  where r.month = p_month
  order by (r.status = 'no_activity') desc, coalesce(c.agency, a.agency), coalesce(c.branch, a.branch);
end;
$$;

revoke all on function admin_branch_reports(date) from public, anon;
grant execute on function admin_branch_reports(date) to authenticated;

-- 4. Unsubscribe ------------------------------------------------------------------------

alter table email_preferences add column if not exists monthly_report boolean not null default true;

-- Check: expect the table, and figures for one branch (or null with no agents).
select
  (select count(*) from branch_monthly_reports) as reports,
  (select branch_report(coalesce(signup_code, 'agent:' || user_id), date_trunc('month', now()), now())
     from agents limit 1) as sample_figures;
