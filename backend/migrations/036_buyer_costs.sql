-- Run once in the Supabase SQL editor (after 035).
--
-- 1. The cost of each home: stamp duty and a monthly mortgage estimate, worked
--    out in the app from the household's buying position. Budget and deposit
--    are already there (015); this adds whether they're first-time buyers and
--    their mortgage rate and term. Blank rate or term = the app's defaults
--    (4.5%, 25 years). Blank first_time_buyer = go by selling_status. These
--    are private to the household: agent_buyer_positions() doesn't return them.
--
-- 2. Viewing photos: taken on the day of a viewing ("Add photo"), private to
--    the household. Stored as <household id>/<property id>/<random id>.jpg in
--    a private bucket; members can add, open and delete photos only in their
--    own household's folder, and only for homes their household has saved.
--    Agents never see them.

-- 1. Cost estimate inputs -------------------------------------------------------

alter table buyer_positions
  add column if not exists first_time_buyer boolean,
  add column if not exists mortgage_rate numeric(5, 2)
    check (mortgage_rate >= 0 and mortgage_rate < 30),
  add column if not exists mortgage_term_years smallint
    check (mortgage_term_years between 1 and 40);

-- 2. Viewing photos -------------------------------------------------------------

-- Photos are shrunk to JPEG in the app; the others are allowed in case a
-- phone can't convert. 10 MB each.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('viewing-photos', 'viewing-photos', false, 10485760,
        array['image/jpeg', 'image/png', 'image/heic', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Is this "<household>/<property>/<file>" path in the caller's household, for
-- one of its saved homes? security definer so the check can read properties
-- whatever that table's own policies say.
create or replace function can_use_viewing_photo(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (storage.foldername(object_name))[1] = current_household_id()::text
    and exists (
      select 1
      from properties p
      where p.id::text = (storage.foldername(object_name))[2]
        and p.household_id = current_household_id()
    );
$$;

revoke all on function can_use_viewing_photo(text) from public, anon;
grant execute on function can_use_viewing_photo(text) to authenticated;

drop policy if exists "viewing photos: household" on storage.objects;
create policy "viewing photos: household" on storage.objects
  for all to authenticated
  using (bucket_id = 'viewing-photos' and can_use_viewing_photo(name))
  with check (bucket_id = 'viewing-photos' and can_use_viewing_photo(name));

-- Check: 3 new columns and the private bucket.
select
  (select count(*) from information_schema.columns
   where table_name = 'buyer_positions'
     and column_name in ('first_time_buyer', 'mortgage_rate', 'mortgage_term_years')) as cost_columns,
  (select public from storage.buckets where id = 'viewing-photos') as photos_bucket_public;
