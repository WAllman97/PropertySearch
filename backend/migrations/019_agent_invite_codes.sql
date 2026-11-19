-- Per-agency sign-up codes for estate agents: run in the Supabase SQL editor,
-- after 018. Safe to run again.
--
-- Agents can only sign up with a code (e.g. BROOKS-7F3A2), so strangers
-- can't fill buyers' cards with fake viewing times. Each code belongs to one
-- agency and has a number of seats: the headcount the agency told us. When
-- the seats are full, the next person can request a place; an admin approves
-- it on /admin (which adds a seat) or declines it. Codes can be switched
-- off. The old single AGENT_SIGNUP_CODE setting in Vercel still works if
-- it's set.

-- 1. Codes -----------------------------------------------------------------------

create table if not exists agent_invite_codes (
  code text primary key check (code ~ '^[A-Z0-9-]{4,40}$'),
  agency text not null check (char_length(agency) between 1 and 100),
  note text check (char_length(note) <= 200),
  -- Seats: how many people can sign up with it. Null: no limit.
  max_uses integer check (max_uses is null or max_uses between 1 and 500),
  uses integer not null default 0 check (uses >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

-- No policies: admins use the functions below; sign-up uses the service role.
alter table agent_invite_codes enable row level security;

-- Which code each agent joined with.
alter table agents
  add column if not exists signup_code text references agent_invite_codes (code) on delete set null;

-- Requests for a place once an agency's seats are full. Written by the
-- sign-up route (service role); read and decided by admins below.
create table if not exists agent_seat_requests (
  id uuid primary key default gen_random_uuid(),
  code text not null references agent_invite_codes (code) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  email text not null check (char_length(email) between 3 and 254),
  branch text check (char_length(branch) <= 100),
  phone text check (char_length(phone) <= 40),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

-- One open request per person per code.
create unique index if not exists agent_seat_requests_one_pending
  on agent_seat_requests (code, lower(email)) where status = 'pending';

alter table agent_seat_requests enable row level security;

-- 2. Admin: create, list, switch off, seats, requests -----------------------------

create or replace function admin_create_agent_code(p_agency text, p_max_uses integer, p_note text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix text;
  new_code text;
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if coalesce(trim(p_agency), '') = '' then
    raise exception 'agency required' using errcode = '22023';
  end if;
  if p_max_uses is null or p_max_uses not between 1 and 500 then
    raise exception 'seats must be between 1 and 500' using errcode = '22023';
  end if;

  -- First word of the agency, letters only, e.g. "Brooks & Co" -> BROOKS.
  prefix := left(upper(regexp_replace(split_part(trim(p_agency), ' ', 1), '[^A-Za-z]', '', 'g')), 10);
  if prefix = '' then prefix := 'AGENT'; end if;

  loop
    new_code := prefix || '-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 5));
    exit when not exists (select 1 from agent_invite_codes where code = new_code);
  end loop;

  insert into agent_invite_codes (code, agency, note, max_uses, created_by)
  values (new_code, trim(p_agency), nullif(trim(p_note), ''), p_max_uses, auth.uid());
  return new_code;
end;
$$;

drop function if exists admin_agent_codes();
create function admin_agent_codes()
returns table (
  code text,
  agency text,
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
    select c.code, c.agency, c.note, c.max_uses, c.uses, c.is_active, c.created_at,
           (select count(*)::integer from agents a where a.signup_code = c.code),
           (select count(*)::integer from agent_seat_requests r
             where r.code = c.code and r.status = 'pending')
    from agent_invite_codes c
    order by c.created_at desc;
end;
$$;

create or replace function admin_set_agent_code_active(p_code text, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  update agent_invite_codes set is_active = p_active where code = p_code;
end;
$$;

create or replace function admin_set_agent_code_seats(p_code text, p_seats integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_seats is null or p_seats not between 1 and 500 then
    raise exception 'seats must be between 1 and 500' using errcode = '22023';
  end if;
  update agent_invite_codes set max_uses = p_seats where code = p_code;
end;
$$;

create or replace function admin_seat_requests()
returns table (
  id uuid,
  code text,
  agency text,
  name text,
  email text,
  branch text,
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
    select r.id, r.code, c.agency, r.name, r.email, r.branch, r.phone, r.created_at,
           c.max_uses, c.uses
    from agent_seat_requests r
    join agent_invite_codes c on c.code = r.code
    where r.status = 'pending'
    order by r.created_at;
end;
$$;

-- Approve: one more seat on the agency's code, so the person can now sign
-- up with the same link. Decline: just closes the request.
create or replace function admin_decide_seat_request(p_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  req_code text;
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  update agent_seat_requests
     set status = case when p_approve then 'approved' else 'declined' end,
         decided_at = now()
   where id = p_id and status = 'pending'
  returning code into req_code;
  if req_code is not null and p_approve then
    update agent_invite_codes
       set max_uses = least(greatest(coalesce(max_uses, uses), uses) + 1, 500)
     where code = req_code;
  end if;
end;
$$;

revoke all on function admin_set_agent_code_seats(text, integer) from public, anon;
grant execute on function admin_set_agent_code_seats(text, integer) to authenticated;
revoke all on function admin_seat_requests() from public, anon;
grant execute on function admin_seat_requests() to authenticated;
revoke all on function admin_decide_seat_request(uuid, boolean) from public, anon;
grant execute on function admin_decide_seat_request(uuid, boolean) to authenticated;

revoke all on function admin_create_agent_code(text, integer, text) from public, anon;
grant execute on function admin_create_agent_code(text, integer, text) to authenticated;
revoke all on function admin_agent_codes() from public, anon;
grant execute on function admin_agent_codes() to authenticated;
revoke all on function admin_set_agent_code_active(text, boolean) from public, anon;
grant execute on function admin_set_agent_code_active(text, boolean) to authenticated;

-- 3. Sign-up (service role only): use up one place on a code -------------------

-- Returns the code's agency, or null if the code is wrong, off or used up.
-- One statement, so two agents can't both take the last place.
create or replace function claim_agent_code(p_code text)
returns text
language sql
security definer
set search_path = public
as $$
  update agent_invite_codes
     set uses = uses + 1
   where code = upper(trim(p_code))
     and is_active
     and (max_uses is null or uses < max_uses)
  returning agency;
$$;

-- Give the place back if the account couldn't be created after all.
create or replace function release_agent_code(p_code text)
returns void
language sql
security definer
set search_path = public
as $$
  update agent_invite_codes set uses = greatest(uses - 1, 0) where code = upper(trim(p_code));
$$;

revoke all on function claim_agent_code(text) from public, anon, authenticated;
grant execute on function claim_agent_code(text) to service_role;
revoke all on function release_agent_code(text) from public, anon, authenticated;
grant execute on function release_agent_code(text) to service_role;

-- 4. Check ----------------------------------------------------------------------

select (select count(*) from agent_invite_codes) as codes,
       (select count(*) from agent_seat_requests) as seat_requests;
