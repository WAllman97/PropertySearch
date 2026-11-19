-- Search by place + distance, or by an area drawn on a map: run once in the
-- Supabase SQL editor, after 015.
--
-- A buyer search can now say where in three ways (any one is enough; a
-- listing matches if it fits any of them):
--   * postcode districts/areas, as before ("SW11", "SW")
--   * a circle: centre + radius ("within 1/2 mile of Battersea")
--   * a polygon drawn on the map
--
-- Listings only carry a postcode. postcode_locations caches where each
-- postcode is (from postcodes.io, filled by the /api/geo route and
-- /api/send-listing). A full postcode is accurate to the street. If we only
-- know the district (SW11) we use its centre and allow 1 km of slack, so a
-- home just inside the area isn't missed.

-- 1. Postcode coordinates cache -------------------------------------------------

create table if not exists postcode_locations (
  -- Upper case, no spaces: a full postcode ("SW111AA") or a district ("SW11").
  postcode text primary key check (postcode ~ '^[A-Z]{1,2}[0-9][0-9A-Z]?([0-9][A-Z]{2})?$'),
  lat double precision not null check (lat between 49 and 61),
  lng double precision not null check (lng between -9 and 3),
  updated_at timestamptz not null default now()
);

-- Service role only (written by the API, read by the security definer
-- matching functions below).
alter table postcode_locations enable row level security;

-- 2. Geometry helpers -------------------------------------------------------------

-- Great-circle distance in metres.
create or replace function distance_m(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
)
returns double precision
language sql
immutable
as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

-- A polygon is a JSON array of [lat, lng] points (3 to 100), all in the UK.
create or replace function is_valid_polygon(p jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  e jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return false; end if;
  if jsonb_array_length(p) not between 3 and 100 then return false; end if;
  for e in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(e) <> 'array' or jsonb_array_length(e) <> 2
       or jsonb_typeof(e -> 0) <> 'number' or jsonb_typeof(e -> 1) <> 'number' then
      return false;
    end if;
    if (e ->> 0)::float8 not between 49 and 61 or (e ->> 1)::float8 not between -9 and 3 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- Metres from a point to a polygon: 0 if inside, else the distance to the
-- nearest edge. Flat-earth maths around the point, fine at city scale.
create or replace function distance_to_polygon_m(
  p_lat double precision, p_lng double precision, p_polygon jsonb
)
returns double precision
language plpgsql
immutable
as $$
declare
  n integer := jsonb_array_length(p_polygon);
  k double precision := cos(radians(p_lat));
  i integer;
  j integer;
  xi double precision; yi double precision;
  xj double precision; yj double precision;
  dx double precision; dy double precision;
  t double precision; d double precision;
  best double precision := 'infinity';
  inside boolean := false;
begin
  if n is null or n < 3 then return null; end if;
  j := n - 1;
  for i in 0 .. n - 1 loop
    -- Vertices in metres, relative to the point (the point is the origin).
    yi := ((p_polygon -> i ->> 0)::float8 - p_lat) * 111320;
    xi := ((p_polygon -> i ->> 1)::float8 - p_lng) * 111320 * k;
    yj := ((p_polygon -> j ->> 0)::float8 - p_lat) * 111320;
    xj := ((p_polygon -> j ->> 1)::float8 - p_lng) * 111320 * k;

    -- Ray cast along +x from the origin.
    if (yi > 0) <> (yj > 0) and (xj - xi) * (0 - yi) / (yj - yi) + xi > 0 then
      inside := not inside;
    end if;

    -- Distance from the origin to this edge.
    dx := xj - xi;
    dy := yj - yi;
    if dx = 0 and dy = 0 then
      t := 0;
    else
      t := greatest(0, least(1, (-xi * dx - yi * dy) / (dx * dx + dy * dy)));
    end if;
    d := sqrt(power(xi + t * dx, 2) + power(yi + t * dy, 2));
    if d < best then best := d; end if;

    j := i;
  end loop;

  if inside then return 0; end if;
  return best;
end;
$$;

-- 3. Search columns ---------------------------------------------------------------

-- Postcodes become optional: drop the old "1 to 40 areas" check.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.buyer_searches'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%areas%'
  loop
    execute format('alter table buyer_searches drop constraint %I', c.conname);
  end loop;
end $$;

alter table buyer_searches
  add constraint buyer_searches_areas_check check (
    cardinality(areas) <= 40
    and (cardinality(areas) = 0
      or array_to_string(areas, ',') ~ '^([A-Z]{1,2}([0-9][0-9A-Z]?)?)(,[A-Z]{1,2}([0-9][0-9A-Z]?)?)*$')
  ),
  add column if not exists center_label text check (length(center_label) <= 120),
  add column if not exists center_lat double precision check (center_lat between 49 and 61),
  add column if not exists center_lng double precision check (center_lng between -9 and 3),
  -- 100 m to 30 miles.
  add column if not exists radius_m integer check (radius_m between 100 and 48280),
  add column if not exists polygon jsonb check (polygon is null or is_valid_polygon(polygon));

alter table buyer_searches drop constraint if exists buyer_searches_circle_complete;
alter table buyer_searches add constraint buyer_searches_circle_complete check (
  (center_lat is null and center_lng is null and radius_m is null)
  or (center_lat is not null and center_lng is not null and radius_m is not null)
);

alter table buyer_searches drop constraint if exists buyer_searches_has_location;
alter table buyer_searches add constraint buyer_searches_has_location check (
  cardinality(areas) > 0 or radius_m is not null or polygon is not null
);

-- 4. Matching (same signature, so callers don't change) ----------------------

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

-- 5. Check ----------------------------------------------------------------------

select round(distance_m(51.4701, -0.1714, 51.4644, -0.1678)) as battersea_to_sw11_1aa_m,  -- ~690
       distance_to_polygon_m(51.5, -0.1, '[[51.4,-0.2],[51.6,-0.2],[51.6,0.0],[51.4,0.0]]') as inside,  -- 0
       round(distance_to_polygon_m(51.5, -0.1, '[[51.51,-0.2],[51.6,-0.2],[51.6,0.0],[51.51,0.0]]')) as outside_m;  -- ~1113
