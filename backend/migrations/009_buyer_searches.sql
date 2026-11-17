-- Buyer search criteria: run once in the Supabase SQL editor.
--
-- Replaces scraping portal search URLs. Each buyer says what they want
-- (areas, price, bedrooms, type, garden); when an agent adds a listing we
-- match it against every active search in one indexed query, instead of
-- crawling Rightmove/Zoopla every day.
--
-- Areas are UK postcode districts ("SW17", "SE24") or whole postcode areas
-- ("SW" = every SW district).

-- 1. Postcode helpers ---------------------------------------------------------

-- "sw17 0ab" / "SW170AB" / "SW17" -> "SW17". Null if it isn't a postcode.
create or replace function postcode_district(p_postcode text)
returns text
language sql
immutable
as $$
  select case
    when p is null or p = '' then null
    -- Full postcode: inward code is always digit + 2 letters.
    when p ~ '^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2}$' then left(p, length(p) - 3)
    -- Already a district.
    when p ~ '^[A-Z]{1,2}[0-9][0-9A-Z]?$' then p
    else null
  end
  from (select upper(regexp_replace(coalesce(p_postcode, ''), '\s', '', 'g')) as p) s;
$$;

-- "SW17" -> "SW", "E1" -> "E".
create or replace function postcode_area(p_district text)
returns text
language sql
immutable
as $$
  select nullif(substring(upper(coalesce(p_district, '')) from '^[A-Z]{1,2}'), '');
$$;

-- 2. Table --------------------------------------------------------------------

create table if not exists buyer_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'My search' check (length(name) between 1 and 80),
  -- Postcode districts or areas, upper case, e.g. {SW17,SE24,SW}.
  areas text[] not null
    check (cardinality(areas) between 1 and 40
      and array_to_string(areas, ',') ~ '^([A-Z]{1,2}([0-9][0-9A-Z]?)?)(,[A-Z]{1,2}([0-9][0-9A-Z]?)?)*$'),
  min_price integer check (min_price is null or min_price >= 0),
  max_price integer check (max_price is null or max_price > 0),
  min_bedrooms smallint check (min_bedrooms is null or min_bedrooms between 0 and 10),
  -- Null = any. Same values agents pick for a listing.
  property_types text[]
    check (property_types is null or property_types <@ array['house', 'flat', 'bungalow']::text[]),
  must_have_garden boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (min_price is null or max_price is null or min_price <= max_price)
);

create index if not exists buyer_searches_user_idx on buyer_searches (user_id);
-- Lets matching use "areas && array[district, area]" without a full scan.
create index if not exists buyer_searches_areas_idx on buyer_searches using gin (areas)
  where is_active;

-- 3. Access: each buyer manages only their own searches -------------------------

alter table buyer_searches enable row level security;

drop policy if exists own_searches on buyer_searches;
create policy own_searches on buyer_searches
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 4. Matching -----------------------------------------------------------------
--
-- Which active searches does a listing fit? Unknown listing values (no
-- bedrooms, no type) don't exclude it, except "must have garden", which
-- needs a definite yes. Service role only: agents must never see who matched.

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
       (select postcode_district(p_postcode) as d) pc
  where s.is_active
    and pc.d is not null
    and s.areas && array[pc.d, postcode_area(pc.d)]
    and (s.min_price is null or p_price is null or p_price >= s.min_price)
    and (s.max_price is null or p_price is null or p_price <= s.max_price)
    and (s.min_bedrooms is null or p_bedrooms is null or p_bedrooms >= s.min_bedrooms)
    and (s.property_types is null or p_property_type is null
         or p_property_type = any (s.property_types))
    and (not s.must_have_garden or coalesce(p_has_garden, false));
$$;

revoke all on function match_buyer_searches(text, integer, integer, text, boolean) from public, anon, authenticated;
grant execute on function match_buyer_searches(text, integer, integer, text, boolean) to service_role;

-- How many distinct buyers would a listing reach? Safe for agents to call:
-- a number only, never who.
create or replace function count_matching_buyers(
  p_postcode text,
  p_price integer,
  p_bedrooms integer,
  p_property_type text,
  p_has_garden boolean
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(distinct m.user_id)::integer
  from match_buyer_searches(p_postcode, p_price, p_bedrooms, p_property_type, p_has_garden) m;
$$;

revoke all on function count_matching_buyers(text, integer, integer, text, boolean) from public, anon;
grant execute on function count_matching_buyers(text, integer, integer, text, boolean) to authenticated, service_role;

-- 5. Check ----------------------------------------------------------------------

select postcode_district('sw17 0ab') as full_pc,   -- SW17
       postcode_district('SE240AB') as no_space,   -- SE24
       postcode_district('w1') as district,         -- W1
       postcode_district('nonsense') as bad,        -- null
       postcode_area('SW17') as area;               -- SW
