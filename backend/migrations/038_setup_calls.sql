-- Run once in the Supabase SQL editor (after 037). Safe to run more than once.
--
-- Agents book their 10-minute setup call with ViewPal themselves, the same
-- way buyers book viewings: no "request a call" and waiting to be rung back.
--
-- 1. setup_call_settings: one row. Call length, notice, how far ahead, an
--    optional Meet link (offered as "video call"), and an on/off switch.
-- 2. setup_call_hours: the weekly hours calls can be booked in (London time).
-- 3. setup_calls: the bookings. Written only by /api/agent-signup (service
--    role); agents never read the table directly.
-- 4. Admin (/admin -> Setup calls): admin_setup_calls, admin_save_setup_calls.
--    Cancelling a call is an API action (admin_cancel_call), so the agent
--    gets an email and the calendar invite is withdrawn.
--
-- Busy times also come from the admin's own calendar: its private iCal link
-- goes in the CALL_CALENDAR_ICS_URL environment variable in Vercel (never in
-- the database), and /api/agent-signup leaves out any time it's busy.

-- 1. Settings -----------------------------------------------------------------------

create table if not exists setup_call_settings (
  id smallint primary key default 1 check (id = 1),
  is_active boolean not null default true,
  slot_minutes smallint not null default 15 check (slot_minutes between 10 and 60),
  min_notice_hours smallint not null default 2 check (min_notice_hours between 0 and 72),
  days_ahead smallint not null default 14 check (days_ahead between 1 and 60),
  meet_url text check (meet_url is null or meet_url ~ '^https://[^\s<>"]+$'),
  updated_at timestamptz not null default now()
);

insert into setup_call_settings (id) values (1) on conflict (id) do nothing;

alter table setup_call_settings enable row level security;
-- No policies: the API reads it with the service role, /admin through the
-- admin functions below.

-- 2. Weekly hours -------------------------------------------------------------------

create table if not exists setup_call_hours (
  id uuid primary key default gen_random_uuid(),
  weekday smallint not null check (weekday between 1 and 7), -- 1 = Monday
  start_time time not null,
  end_time time not null,
  check (end_time > start_time)
);

-- Weekdays 9:00-17:30 to start with; change them on /admin.
insert into setup_call_hours (weekday, start_time, end_time)
select d, '09:00', '17:30'
from generate_series(1, 5) as d
where not exists (select 1 from setup_call_hours);

alter table setup_call_hours enable row level security;

-- 3. Bookings -----------------------------------------------------------------------

create table if not exists setup_calls (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents (user_id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  -- 'phone': we ring the agent on `phone`. 'video': the Meet link.
  kind text not null default 'phone' check (kind in ('phone', 'video')),
  phone text check (char_length(phone) <= 40),
  note text check (char_length(note) <= 500),
  status text not null default 'booked' check (status in ('booked', 'cancelled')),
  cancelled_by text check (cancelled_by in ('agent', 'admin')),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  reminder_sent_at timestamptz,
  -- Bumped on each change, so calendar updates replace the earlier invite.
  sequence smallint not null default 0
);

-- Two agents can't take the same time (the API checks overlaps too, in case
-- the call length changes).
create unique index if not exists setup_calls_one_per_time
  on setup_calls (starts_at) where status = 'booked';
create index if not exists setup_calls_agent on setup_calls (agent_id, starts_at desc);
create index if not exists setup_calls_upcoming on setup_calls (starts_at) where status = 'booked';

alter table setup_calls enable row level security;

-- 4. Admin --------------------------------------------------------------------------

-- Everything /admin -> Setup calls shows: settings, hours, and calls from
-- the last week on (cancelled ones included, so you can see what changed).
create or replace function admin_setup_calls()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'settings', (select to_jsonb(s) from setup_call_settings s where id = 1),
    'hours', coalesce((
      select jsonb_agg(jsonb_build_object(
               'weekday', h.weekday,
               'start_time', to_char(h.start_time, 'HH24:MI'),
               'end_time', to_char(h.end_time, 'HH24:MI'))
             order by h.weekday, h.start_time)
      from setup_call_hours h), '[]'::jsonb),
    'calls', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'agent_id', c.agent_id,
               'starts_at', c.starts_at,
               'ends_at', c.ends_at,
               'kind', c.kind,
               'phone', coalesce(c.phone, a.phone),
               'note', c.note,
               'status', c.status,
               'cancelled_by', c.cancelled_by,
               'created_at', c.created_at,
               'name', a.name,
               'email', a.email,
               'agency', a.agency,
               'branch', a.branch,
               'on_trial', a.signup_code is null and a.trial_ends_at is not null,
               'trial_ends_at', a.trial_ends_at)
             order by c.starts_at)
      from setup_calls c
      join agents a on a.user_id = c.agent_id
      where c.starts_at > now() - interval '7 days'), '[]'::jsonb)
  );
end;
$$;

revoke all on function admin_setup_calls() from public, anon;
grant execute on function admin_setup_calls() to authenticated;

-- Save settings and replace the weekly hours in one go.
--   p_settings: { is_active, slot_minutes, min_notice_hours, days_ahead, meet_url }
--   p_hours:    [{ weekday, start_time: "09:00", end_time: "17:30" }]
create or replace function admin_save_setup_calls(p_settings jsonb, p_hours jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_app_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  update setup_call_settings set
    is_active = coalesce((p_settings ->> 'is_active')::boolean, is_active),
    slot_minutes = coalesce((p_settings ->> 'slot_minutes')::smallint, slot_minutes),
    min_notice_hours = coalesce((p_settings ->> 'min_notice_hours')::smallint, min_notice_hours),
    days_ahead = coalesce((p_settings ->> 'days_ahead')::smallint, days_ahead),
    meet_url = nullif(trim(coalesce(p_settings ->> 'meet_url', '')), ''),
    updated_at = now()
  where id = 1;

  if p_hours is not null then
    delete from setup_call_hours where true;
    insert into setup_call_hours (weekday, start_time, end_time)
    select (h ->> 'weekday')::smallint, (h ->> 'start_time')::time, (h ->> 'end_time')::time
    from jsonb_array_elements(p_hours) as h;
  end if;
end;
$$;

revoke all on function admin_save_setup_calls(jsonb, jsonb) from public, anon;
grant execute on function admin_save_setup_calls(jsonb, jsonb) to authenticated;
