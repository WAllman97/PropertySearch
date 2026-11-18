-- Many households: run once in the Supabase SQL editor.
--
-- Until now there was one household: everyone in household_members saw every
-- property. After this, each household has its own property list, notes,
-- price history and commute addresses. Buyers sign up through
-- /api/buyer-signup, which creates a household, or joins one through a
-- partner's invite link.
--
-- The existing household becomes the "original" one. The scraper, its daily
-- email and AI scoring keep working for it only.

-- 1. Households --------------------------------------------------------------

create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our household' check (char_length(name) <= 100),
  -- 24 random hex characters (gen_random_uuid is built in; pgcrypto lives in
  -- Supabase's extensions schema, out of reach of search_path = public).
  invite_code text not null unique default left(replace(gen_random_uuid()::text, '-', ''), 24),
  is_original boolean not null default false,
  created_at timestamptz not null default now()
);

-- At most one original household (the one the scraper fills).
create unique index if not exists households_one_original
  on households (is_original) where is_original;

-- RLS on with no policies: clients only see their own household through
-- my_household() below; sign-up and deletion go through the service role.
alter table households enable row level security;

insert into households (name, is_original)
select 'Our household', true
where not exists (select 1 from households where is_original);

-- 2. Members belong to one household -------------------------------------------

alter table household_members
  add column if not exists household_id uuid references households (id) on delete cascade;

update household_members
set household_id = (select id from households where is_original)
where household_id is null;

alter table household_members alter column household_id set not null;

create index if not exists household_members_household_idx
  on household_members (household_id);

create or replace function current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from household_members where user_id = auth.uid();
$$;

revoke all on function current_household_id() from public;
grant execute on function current_household_id() to authenticated, anon;

-- 3. Properties belong to a household ------------------------------------------

alter table properties
  add column if not exists household_id uuid references households (id) on delete cascade;

update properties
set household_id = (select id from households where is_original)
where household_id is null;

alter table properties alter column household_id set not null;

-- Saving from the browser fills it in automatically.
alter table properties alter column household_id set default current_household_id();

create index if not exists properties_household_idx on properties (household_id);

-- listing_url (and listing_id, if it was unique) were unique across the whole
-- table. Two households must be able to save the same home, so make them
-- unique per household instead. The original constraints were made in the
-- dashboard, so find them by their columns rather than by name.
do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.properties'::regclass
      and c.contype = 'u'
      and array_length(c.conkey, 1) = 1
      and (select attname from pg_attribute
           where attrelid = c.conrelid and attnum = c.conkey[1])
          in ('listing_url', 'listing_id')
  loop
    execute format('alter table properties drop constraint %I', r.conname);
  end loop;

  for r in
    select i.relname as indexname
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    where x.indrelid = 'public.properties'::regclass
      and x.indisunique
      and not x.indisprimary
      and x.indnatts = 1
      and (select attname from pg_attribute
           where attrelid = x.indrelid and attnum = x.indkey[0])
          in ('listing_url', 'listing_id')
  loop
    execute format('drop index %I', r.indexname);
  end loop;
end $$;

create unique index if not exists properties_household_listing_url
  on properties (household_id, listing_url);
create unique index if not exists properties_household_listing_id
  on properties (household_id, listing_id);

-- 4. Row-level security: your household's rows only ---------------------------
--
-- The restrictive household_only policies from 002/005 stay ("must be in a
-- household"); these permissive ones now pick out which household.

drop policy if exists household_access on properties;
create policy household_access on properties
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

drop policy if exists household_access on property_notes;
create policy household_access on property_notes
  for all to authenticated
  using (exists (select 1 from properties p
                 where p.id = property_id and p.household_id = current_household_id()))
  with check (exists (select 1 from properties p
                      where p.id = property_id and p.household_id = current_household_id()));

drop policy if exists household_access on price_history;
create policy household_access on price_history
  for all to authenticated
  using (exists (select 1 from properties p
                 where p.id = property_id and p.household_id = current_household_id()))
  with check (exists (select 1 from properties p
                      where p.id = property_id and p.household_id = current_household_id()));

-- 5. Commute addresses are the household's, not one person's -----------------
--
-- buyer_profiles already holds both "your" and "partner" work addresses, and
-- the commute times it produces are stored on the shared property rows.

alter table buyer_profiles
  add column if not exists household_id uuid references households (id) on delete cascade;

update buyer_profiles b
set household_id = m.household_id
from household_members m
where m.user_id = b.user_id and b.household_id is null;

-- One profile per household: keep the most recently updated if there are more.
delete from buyer_profiles b
using buyer_profiles newer
where b.household_id is not null
  and newer.household_id = b.household_id
  and (newer.updated_at, newer.id) > (b.updated_at, b.id);

alter table buyer_profiles alter column household_id set default current_household_id();

create unique index if not exists buyer_profiles_household_unique
  on buyer_profiles (household_id);

drop policy if exists household_access on buyer_profiles;
create policy household_access on buyer_profiles
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

-- 6. Agent viewing times: only for homes your household saved -----------------

create or replace function available_viewings()
returns table (
  property_id uuid,
  slot_id uuid,
  listing_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  capacity smallint,
  booked integer,
  my_booking_id uuid,
  agent_name text,
  agency text,
  branch text,
  listing_notes text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    s.id,
    l.id,
    s.starts_at,
    s.ends_at,
    s.capacity,
    (select count(*)::int from viewing_bookings b
      where b.slot_id = s.id and b.status = 'confirmed'),
    (select b.id from viewing_bookings b
      where b.slot_id = s.id and b.status = 'confirmed' and b.buyer_id = auth.uid()
      limit 1),
    a.name,
    a.agency,
    a.branch,
    l.notes
  from properties p
  join agent_listings l
    on l.listing_key = listing_key(p.listing_url) and l.is_active
  join agents a on a.user_id = l.agent_id
  join viewing_slots s
    on s.listing_id = l.id and s.cancelled_at is null and s.starts_at > now()
  where p.household_id = current_household_id()
  order by s.starts_at;
$$;

revoke all on function available_viewings() from public, anon;
grant execute on function available_viewings() to authenticated;

-- 7. Household settings for the app --------------------------------------------

-- Your household, its invite code and who's in it. Members' emails are only
-- shown to people in the same household.
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

-- New invite link: the old one stops working (e.g. if it was shared by mistake).
create or replace function reset_household_invite()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  hid uuid := current_household_id();
  code text := left(replace(gen_random_uuid()::text, '-', ''), 24);
begin
  if hid is null then
    raise exception 'not in a household';
  end if;
  update households set invite_code = code where id = hid;
  return code;
end;
$$;

revoke all on function reset_household_invite() from public, anon;
grant execute on function reset_household_invite() to authenticated;

-- 8. Check -------------------------------------------------------------------

select h.name, h.is_original,
       (select count(*) from household_members m where m.household_id = h.id) as members,
       (select count(*) from properties p where p.household_id = h.id) as properties,
       (select count(*) from buyer_profiles b where b.household_id = h.id) as profiles
from households h;
