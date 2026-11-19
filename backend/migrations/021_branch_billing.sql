-- Billing per branch, not per agent login: run in the Supabase SQL editor,
-- after 020. Safe to run again.
--
-- Pricing is per branch, so plan and fee live on the branch (its sign-up
-- code), and the admin dashboard counts branches: a branch with six
-- negotiators is one branch and one fee. Agents who joined before codes
-- existed count as a branch of their own (key 'agent:<their id>').
-- Billing already set per agent carries over to that agent's branch.

-- 1. Billing per branch ---------------------------------------------------------

create table if not exists branch_billing (
  -- A sign-up code, or 'agent:<user id>' for an agent without one.
  branch_key text primary key check (char_length(branch_key) <= 60),
  plan text not null default 'pilot' check (plan in ('pilot', 'paying', 'cancelled')),
  monthly_fee integer check (monthly_fee is null or (monthly_fee >= 0 and monthly_fee < 100000)),
  paying_since date,
  cancelled_at date,
  updated_at timestamptz not null default now()
);

alter table branch_billing enable row level security;

-- Carry over what was set per agent: a branch is paying if any of its
-- people was marked paying.
insert into branch_billing (branch_key, plan, monthly_fee, paying_since, cancelled_at, updated_at)
select distinct on (coalesce(a.signup_code, 'agent:' || a.user_id))
       coalesce(a.signup_code, 'agent:' || a.user_id),
       b.plan, b.monthly_fee, b.paying_since, b.cancelled_at, b.updated_at
from agent_billing b
join agents a on a.user_id = b.agent_id
order by coalesce(a.signup_code, 'agent:' || a.user_id), (b.plan = 'paying') desc, b.updated_at desc
on conflict (branch_key) do nothing;

create or replace function admin_set_branch_billing(p_branch text, p_plan text, p_fee integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if not (
    exists (select 1 from agent_invite_codes where code = p_branch)
    or exists (select 1 from agents where 'agent:' || user_id = p_branch and signup_code is null)
  ) then
    raise exception 'no such branch' using errcode = '22023';
  end if;
  insert into branch_billing (branch_key, plan, monthly_fee, paying_since, cancelled_at, updated_at)
  values (
    p_branch, p_plan, p_fee,
    case when p_plan = 'paying' then current_date end,
    case when p_plan = 'cancelled' then current_date end,
    now()
  )
  on conflict (branch_key) do update set
    plan = excluded.plan,
    monthly_fee = excluded.monthly_fee,
    paying_since = case
      when excluded.plan = 'paying' then coalesce(branch_billing.paying_since, current_date)
      else branch_billing.paying_since end,
    cancelled_at = case when excluded.plan = 'cancelled' then current_date end,
    updated_at = now();
end;
$$;

revoke all on function admin_set_branch_billing(text, text, integer) from public, anon;
grant execute on function admin_set_branch_billing(text, text, integer) to authenticated;

-- 2. Dashboard numbers by branch (replaces the 018 version) ------------------------

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

-- 3. Check ----------------------------------------------------------------------

select (select count(*) from branch_billing) as branches_with_billing,
       (select count(*) from agent_billing) as old_per_agent_billing;
