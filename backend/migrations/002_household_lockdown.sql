-- Household lockdown: run once in the Supabase SQL editor.
--
-- Before this, the `properties` table was readable by anyone holding the
-- public anon key (it ships in the frontend bundle), without signing in, and
-- public sign-ups were open, so any stranger could create an account and get
-- whatever "authenticated" access the other tables allow.
--
-- After this, only accounts listed in `household_members` can read or write
-- app data. The backend jobs use the service-role key, which bypasses RLS,
-- so the scraper and email jobs are unaffected.
--
-- Also do in the dashboard: Authentication -> Sign In / Providers ->
-- turn OFF "Allow new users to sign up".

-- 1. Allow-list -------------------------------------------------------------

create table if not exists household_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

-- RLS on with no policies: only the service role / SQL editor can see or
-- change the list. Clients can't add themselves.
alter table household_members enable row level security;

-- Seed with every existing account that has confirmed its email.
-- Check the result below; to add someone later (e.g. a partner):
--   insert into household_members (user_id)
--   select id from auth.users where email = 'their@email';
insert into household_members (user_id)
select id from auth.users where email_confirmed_at is not null
on conflict do nothing;

do $$
begin
  if not exists (select 1 from household_members) then
    raise exception 'household_members is empty: add your user id before locking tables';
  end if;
end $$;

-- SECURITY DEFINER so policies can consult the list without clients being
-- able to read it directly.
create or replace function is_household_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from household_members where user_id = auth.uid());
$$;

revoke all on function is_household_member() from public;
grant execute on function is_household_member() to authenticated, anon;

-- 2. Lock every app table ---------------------------------------------------
--
-- A RESTRICTIVE policy is AND-ed with whatever permissive policies already
-- exist, so this closes access for non-members without needing to know or
-- drop the existing policies (per-user policies on buyer_profiles etc. keep
-- working for members).

do $$
declare
  t text;
begin
  foreach t in array array[
    'properties', 'property_notes', 'buyer_profiles',
    'notification_settings', 'search_criteria'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists household_only on %I', t);
    execute format(
      'create policy household_only on %I as restrictive for all
         to public using (is_household_member()) with check (is_household_member())',
      t
    );
  end loop;
end $$;

-- 3. Shared tables need a permissive policy too ------------------------------
--
-- properties and property_notes are shared across the household (no user_id
-- column). If RLS was previously off on them there may be no permissive
-- policy, and enabling RLS alone would hide every row from the app.

drop policy if exists household_access on properties;
create policy household_access on properties
  for all to authenticated
  using (is_household_member()) with check (is_household_member());

drop policy if exists household_access on property_notes;
create policy household_access on property_notes
  for all to authenticated
  using (is_household_member()) with check (is_household_member());

-- 4. Check ------------------------------------------------------------------

select m.user_id, u.email, u.email_confirmed_at is not null as confirmed
from household_members m join auth.users u on u.id = m.user_id;
