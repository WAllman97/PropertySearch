-- Run once in the Supabase SQL editor.
--
-- Buyer search status: one tap tells every agent at once.
--   searching  - looking; agents' matching homes are sent as normal
--   paused     - taking a break, optionally until a date (then looking again
--                on its own)
--   found      - found somewhere (set automatically when an accepted offer is
--                reported, api/offers.js)
-- Paused and found households drop out of matching, so agents' match counts
-- and sends skip them, and agents they've booked with or made an offer to see
-- the status next to their name. It belongs to the household: one buyer.

-- 1. The status --------------------------------------------------------------

alter table households
  add column if not exists search_status text not null default 'searching',
  add column if not exists paused_until date,
  add column if not exists search_status_at timestamptz;

alter table households drop constraint if exists households_search_status_check;
alter table households add constraint households_search_status_check
  check (search_status in ('searching', 'paused', 'found'));

-- Looking right now? A pause with a date ends by itself.
create or replace function household_is_searching(h households)
returns boolean
language sql
stable
as $$
  select h.search_status = 'searching'
      or (h.search_status = 'paused' and h.paused_until is not null and h.paused_until <= current_date);
$$;

-- The status as everyone should see it (an expired pause reads 'searching').
create or replace function household_search_status(h households)
returns text
language sql
stable
as $$
  select case when household_is_searching(h) then 'searching' else h.search_status end;
$$;

-- 2. Changing it (household members, from the app) ---------------------------

create or replace function set_search_status(p_status text, p_paused_until date default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  hid uuid := current_household_id();
begin
  if hid is null then raise exception 'Not in a household'; end if;
  if p_status not in ('searching', 'paused', 'found') then raise exception 'Unknown status'; end if;
  if p_paused_until is not null and (p_status <> 'paused' or p_paused_until <= current_date) then
    raise exception 'Pause date must be in the future';
  end if;
  update households
  set search_status = p_status,
      paused_until = case when p_status = 'paused' then p_paused_until end,
      search_status_at = now()
  where id = hid;
  return json_build_object('search_status', p_status, 'paused_until', p_paused_until);
end;
$$;

revoke all on function set_search_status(text, date) from public, anon;
grant execute on function set_search_status(text, date) to authenticated;

-- 3. Matching skips buyers who aren't looking (same signature as 016) ------

create or replace function match_buyer_searches(
  p_postcode text,
  p_price integer,
  p_bedrooms integer,
  p_property_type text,
  p_has_garden boolean
)
returns table (search_id uuid, user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.user_id
  from buyer_searches s,
       (select postcode_district(p_postcode) as d,
               upper(regexp_replace(coalesce(p_postcode, ''), '\s', '', 'g')) as full_pc) pc
       left join lateral (
         -- Full postcode if we have it, else the district's centre.
         select l.lat, l.lng, (l.postcode = pc.d) as is_district
         from postcode_locations l
         where l.postcode in (pc.full_pc, pc.d)
         order by (l.postcode = pc.d)
         limit 1
       ) loc on true
  where s.is_active
    and pc.d is not null
    and not exists (
      select 1
      from household_members m
      join households h on h.id = m.household_id
      where m.user_id = s.user_id and not household_is_searching(h)
    )
    and (
      s.areas && array[pc.d, postcode_area(pc.d)]
      or (s.radius_m is not null and loc.lat is not null
          and distance_m(loc.lat, loc.lng, s.center_lat, s.center_lng)
              <= s.radius_m + case when loc.is_district then 1000 else 0 end)
      or (s.polygon is not null and loc.lat is not null
          and distance_to_polygon_m(loc.lat, loc.lng, s.polygon)
              <= case when loc.is_district then 1000 else 0 end)
    )
    and (s.min_price is null or p_price is null or p_price >= s.min_price)
    and (s.max_price is null or p_price is null or p_price <= s.max_price)
    and (s.min_bedrooms is null or p_bedrooms is null or p_bedrooms >= s.min_bedrooms)
    and (s.property_types is null or p_property_type is null
         or p_property_type = any (s.property_types))
    and (not s.must_have_garden or coalesce(p_has_garden, false));
$$;

revoke all on function match_buyer_searches(text, integer, integer, text, boolean) from public, anon, authenticated;
grant execute on function match_buyer_searches(text, integer, integer, text, boolean) to service_role;

-- 4. Agents see the status of buyers they deal with -------------------------
-- Same buyers as agent_buyer_positions (017), but shown whether or not the
-- buying position is shared: telling agents is the point of the status.

create or replace function agent_buyer_statuses()
returns table (buyer_id uuid, search_status text, paused_until date, changed_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id, household_search_status(h), h.paused_until, h.search_status_at
  from (select distinct id from agent_buyer_ids() as id) mb
  join household_members m on m.user_id = mb.id
  join households h on h.id = m.household_id;
$$;

revoke all on function agent_buyer_statuses() from public, anon;
grant execute on function agent_buyer_statuses() to authenticated;

-- 5. The app's household card includes it -----------------------------------

create or replace function my_household()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'id', h.id,
    'name', h.name,
    'is_original', h.is_original,
    'invite_code', h.invite_code,
    'search_status', household_search_status(h),
    'paused_until', case when household_is_searching(h) then null else h.paused_until end,
    'search_status_at', h.search_status_at,
    'members', (
      select coalesce(json_agg(json_build_object(
        'email', u.email,
        'name', u.raw_user_meta_data ->> 'name',
        'is_me', u.id = auth.uid(),
        'joined_at', m.added_at
      ) order by m.added_at), '[]'::json)
      from household_members m
      join auth.users u on u.id = m.user_id
      where m.household_id = h.id
    )
  )
  from households h
  where h.id = current_household_id();
$$;

revoke all on function my_household() from public, anon;
grant execute on function my_household() to authenticated;

-- 6. Check: every household should say 'searching' to start with ----------

select search_status, count(*) from households group by search_status;
