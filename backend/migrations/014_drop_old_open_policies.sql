-- Close the gap 013 left: run once in the Supabase SQL editor, straight
-- after 013.
--
-- properties and property_notes were created in the dashboard, which added
-- broad permissive policies of its own (e.g. "authenticated users can do
-- anything"). Permissive policies are OR-ed together, so those let ANY
-- household see and edit every household's homes and notes. Until 013 the
-- restrictive household_only policy hid that (only one household existed);
-- with open sign-up it no longer does.
--
-- This drops every permissive policy on those two tables except 013's
-- household_access, whatever it's called, then shows what's left.

do $$
declare
  r record;
begin
  for r in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('properties', 'property_notes')
      and permissive = 'PERMISSIVE'
      and policyname <> 'household_access'
  loop
    raise notice 'dropping % on %', r.policyname, r.tablename;
    execute format('drop policy %I on %I', r.policyname, r.tablename);
  end loop;
end $$;

-- Two empty tables left over from an early version and unused by the app.
-- Lock them (RLS on, no policies) so new accounts can't write to them.
do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'saved_properties'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table %I enable row level security', t);
    end if;
  end loop;
end $$;

-- Check: properties and property_notes should each show household_access
-- (permissive) and household_only (restrictive), nothing else.
select tablename, policyname, permissive, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('properties', 'property_notes', 'price_history', 'buyer_profiles')
order by tablename, policyname;
