-- Admin dashboard (/admin): run once in the Supabase SQL editor, after 017.
--
-- One function, admin_metrics(), returns everything the dashboard shows,
-- computed from the live tables. Only accounts in app_admins can call it.
-- The first admin is the founding member of the original household (the
-- account the scraper was built for); add others by hand:
--   insert into app_admins (user_id) select id from auth.users where email = '...';
--
-- Agent billing isn't automated yet: agent_billing records each branch's plan
-- (pilot / paying / cancelled) and monthly fee, set from the dashboard, so
-- recurring revenue and pilot-to-paid conversion can be tracked by hand.
--
-- Buyer figures leave out the original household (the founder's own use).
--
-- Targets live in admin_targets, readable only through admin_metrics(). They
-- are deliberately NOT seeded here: this repository is public, so the
-- business plan is entered separately in the SQL editor, never committed.

-- 1. Who is an admin -----------------------------------------------------------

create table if not exists app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

-- Service role and the functions below only.
alter table app_admins enable row level security;

insert into app_admins (user_id)
select m.user_id
from household_members m
join households h on h.id = m.household_id
where h.is_original
order by m.added_at
limit 1
on conflict do nothing;

create or replace function is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from app_admins where user_id = auth.uid());
$$;

revoke all on function is_app_admin() from public, anon;
grant execute on function is_app_admin() to authenticated;

-- 2. Agent billing (set by hand from the dashboard) ---------------------------

create table if not exists agent_billing (
  agent_id uuid primary key references agents (user_id) on delete cascade,
  plan text not null default 'pilot' check (plan in ('pilot', 'paying', 'cancelled')),
  monthly_fee integer check (monthly_fee is null or (monthly_fee >= 0 and monthly_fee < 100000)),
  paying_since date,
  cancelled_at date,
  updated_at timestamptz not null default now()
);

alter table agent_billing enable row level security;

create or replace function admin_set_agent_billing(p_agent uuid, p_plan text, p_fee integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  insert into agent_billing (agent_id, plan, monthly_fee, paying_since, cancelled_at, updated_at)
  values (
    p_agent, p_plan, p_fee,
    case when p_plan = 'paying' then current_date end,
    case when p_plan = 'cancelled' then current_date end,
    now()
  )
  on conflict (agent_id) do update set
    plan = excluded.plan,
    monthly_fee = excluded.monthly_fee,
    paying_since = case
      when excluded.plan = 'paying' then coalesce(agent_billing.paying_since, current_date)
      else agent_billing.paying_since end,
    cancelled_at = case when excluded.plan = 'cancelled' then current_date end,
    updated_at = now();
end;
$$;

revoke all on function admin_set_agent_billing(uuid, text, integer) from public, anon;
grant execute on function admin_set_agent_billing(uuid, text, integer) to authenticated;

-- 3. Targets (filled in by hand; see the note at the top) -------------------------

create table if not exists admin_targets (
  period text primary key check (char_length(period) <= 20),   -- e.g. 'Q1 2027'
  ends date not null,
  branches integer,
  paying integer,
  households integer,
  viewings integer,       -- in the last 30 days, by the end of the period
  offers integer,         -- reported during the period
  mrr integer,            -- pounds a month
  activation_pct integer, -- % of new households activated in week one
  conversion_pct integer  -- % of branches that ever paid
);

alter table admin_targets enable row level security;

-- 4. The numbers ----------------------------------------------------------------

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
  agent_rows as (
    select
      a.user_id, a.name, a.agency, a.branch, a.email, a.created_at,
      coalesce(b.plan, 'pilot') as plan, b.monthly_fee, b.paying_since,
      (select count(*) from agent_listings l where l.agent_id = a.user_id and l.is_active) as listings,
      (select count(*) from viewing_slots s where s.agent_id = a.user_id
         and s.created_at > now() - interval '30 days') as slots_30d,
      (select count(*) from viewings v where v.agent_id = a.user_id
         and v.created_at > now() - interval '30 days') as viewings_30d,
      (select count(*) from listing_sends ls join agent_listings l on l.id = ls.listing_id
         where l.agent_id = a.user_id and ls.sent_at > now() - interval '30 days') as sends_30d,
      greatest(
        (select max(l.created_at) from agent_listings l where l.agent_id = a.user_id),
        (select max(s.created_at) from viewing_slots s where s.agent_id = a.user_id),
        (select max(ls.sent_at) from listing_sends ls join agent_listings l on l.id = ls.listing_id
           where l.agent_id = a.user_id)
      ) as last_activity
    from agents a
    left join agent_billing b on b.agent_id = a.user_id
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
      'total', (select count(*) from agent_rows),
      'active_30d', (select count(*) from agent_rows
                       where slots_30d > 0 or sends_30d > 0 or last_activity > now() - interval '30 days'),
      'paying', (select count(*) from agent_rows where plan = 'paying'),
      'pilot', (select count(*) from agent_rows where plan = 'pilot'),
      'cancelled', (select count(*) from agent_rows where plan = 'cancelled'),
      'ever_paid', (select count(*) from agent_billing where paying_since is not null),
      'mrr', (select coalesce(sum(monthly_fee), 0) from agent_rows where plan = 'paying'),
      'list', (select coalesce(json_agg(r order by r.created_at desc), '[]'::json) from agent_rows r)
    )
  ) into result;

  return result;
end;
$$;

revoke all on function admin_metrics() from public, anon;
grant execute on function admin_metrics() to authenticated;

-- 5. Check -------------------------------------------------------------------------

select (select count(*) from app_admins) as admins,
       (select count(*) from agents) as agents;
