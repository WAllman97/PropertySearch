-- Run once in the Supabase SQL editor (after 031).
--
-- Security fixes from the 24 Nov 2026 review. Safe to run more than once.
--
-- 1. Agents' private links stay private. Households could read the agent's
--    one-tap token on their own offers (offers.agent_token) and viewing
--    requests (viewing_requests.token), and with it "confirm" as the agent.
--    Row-level security can't hide one column, so the household gets
--    SELECT on every other column instead. The server (service role) is
--    unaffected.
--    NOTE: a column added to either table later must be granted the same
--    way (re-running this file does it).
-- 2. Agents can't rewrite their own sign-up code, agency or branch from the
--    browser (that would dodge branch billing and change the agency name
--    buyers see). The app never updates agents directly; the server does.
-- 3. An agent only sees the position, proof documents and status of buyers
--    with a confirmed (not cancelled) booking, or who made an offer.

-- 1. ------------------------------------------------------------------------
do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'offers' and column_name <> 'agent_token';
  execute 'revoke select on public.offers from anon, authenticated';
  execute format('grant select (%s) on public.offers to authenticated', cols);

  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'viewing_requests' and column_name <> 'token';
  execute 'revoke select on public.viewing_requests from anon, authenticated';
  execute format('grant select (%s) on public.viewing_requests to authenticated', cols);
end $$;

-- 2. ------------------------------------------------------------------------
drop policy if exists own_agent_update on agents;
revoke update on agents from anon, authenticated;

-- 3. ------------------------------------------------------------------------
create or replace function agent_buyer_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select ids.id
  from (
    select b.buyer_id as id
    from viewing_bookings b
    join viewing_slots s on s.id = b.slot_id
    where s.agent_id = auth.uid() and b.buyer_id is not null and b.status = 'confirmed'
    union
    select o.reported_by
    from offers o
    join agent_listings l on l.id = o.agent_listing_id
    where l.agent_id = auth.uid() and o.reported_by is not null
  ) ids
  where not exists (
    select 1
    from household_members m
    join buyer_agent_prefs p on p.household_id = m.household_id
    where m.user_id = ids.id and p.agent_id = auth.uid() and not p.share_info
  );
$$;

-- Check: the first two should be false, the third true.
select
  has_column_privilege('authenticated', 'public.offers', 'agent_token', 'select') as buyers_can_read_agent_token,
  has_table_privilege('authenticated', 'public.agents', 'update') as agents_can_update_own_row,
  has_column_privilege('authenticated', 'public.offers', 'amount', 'select') as buyers_can_read_offer_amount;
