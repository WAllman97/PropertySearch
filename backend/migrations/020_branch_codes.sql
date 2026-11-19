-- Sign-up codes per branch, not just per agency: run in the Supabase SQL
-- editor, after 019. Safe to run again.
--
-- Pricing is per branch, so each code belongs to one branch of an agency
-- (Brooks · Wandsworth), with that branch's headcount as its seats. Agents
-- who join with a code get the code's agency and branch, so everyone at a
-- branch is grouped together.

-- 1. Branch on the code ---------------------------------------------------------

alter table agent_invite_codes
  add column if not exists branch text check (char_length(branch) <= 100);

-- 2. Create: agency + branch (replaces the agency-only version) ----------------

drop function if exists admin_create_agent_code(text, integer, text);

create or replace function admin_create_agent_code(
  p_agency text, p_branch text, p_max_uses integer, p_note text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix text;
  branch_part text;
  new_code text;
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if coalesce(trim(p_agency), '') = '' then
    raise exception 'agency required' using errcode = '22023';
  end if;
  if coalesce(trim(p_branch), '') = '' then
    raise exception 'branch required' using errcode = '22023';
  end if;
  if p_max_uses is null or p_max_uses not between 1 and 500 then
    raise exception 'seats must be between 1 and 500' using errcode = '22023';
  end if;

  -- First word of each, letters only: "Brooks & Co", "Wandsworth Town"
  -- -> BROOKS-WANDSWORTH-7F3A2.
  prefix := left(upper(regexp_replace(split_part(trim(p_agency), ' ', 1), '[^A-Za-z]', '', 'g')), 10);
  if prefix = '' then prefix := 'AGENT'; end if;
  branch_part := left(upper(regexp_replace(split_part(trim(p_branch), ' ', 1), '[^A-Za-z]', '', 'g')), 12);
  if branch_part <> '' then prefix := prefix || '-' || branch_part; end if;

  loop
    new_code := prefix || '-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 5));
    exit when not exists (select 1 from agent_invite_codes where code = new_code);
  end loop;

  insert into agent_invite_codes (code, agency, branch, note, max_uses, created_by)
  values (new_code, trim(p_agency), trim(p_branch), nullif(trim(p_note), ''), p_max_uses, auth.uid());
  return new_code;
end;
$$;

revoke all on function admin_create_agent_code(text, text, integer, text) from public, anon;
grant execute on function admin_create_agent_code(text, text, integer, text) to authenticated;

-- 3. Lists include the branch ------------------------------------------------------

drop function if exists admin_agent_codes();
create function admin_agent_codes()
returns table (
  code text,
  agency text,
  branch text,
  note text,
  max_uses integer,
  uses integer,
  is_active boolean,
  created_at timestamptz,
  agents_joined integer,
  pending_requests integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return query
    select c.code, c.agency, c.branch, c.note, c.max_uses, c.uses, c.is_active, c.created_at,
           (select count(*)::integer from agents a where a.signup_code = c.code),
           (select count(*)::integer from agent_seat_requests r
             where r.code = c.code and r.status = 'pending')
    from agent_invite_codes c
    order by c.agency, c.branch, c.created_at desc;
end;
$$;

revoke all on function admin_agent_codes() from public, anon;
grant execute on function admin_agent_codes() to authenticated;

drop function if exists admin_seat_requests();
create function admin_seat_requests()
returns table (
  id uuid,
  code text,
  agency text,
  branch text,
  name text,
  email text,
  phone text,
  created_at timestamptz,
  seats integer,
  used integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return query
    select r.id, r.code, c.agency, coalesce(c.branch, r.branch), r.name, r.email, r.phone,
           r.created_at, c.max_uses, c.uses
    from agent_seat_requests r
    join agent_invite_codes c on c.code = r.code
    where r.status = 'pending'
    order by r.created_at;
end;
$$;

revoke all on function admin_seat_requests() from public, anon;
grant execute on function admin_seat_requests() to authenticated;

-- 4. Check ----------------------------------------------------------------------

select count(*) filter (where branch is null) as codes_without_branch,
       count(*) as codes
from agent_invite_codes;
