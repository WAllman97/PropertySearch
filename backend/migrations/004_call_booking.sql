-- Call / viewing booking: run once in the Supabase SQL editor, after 003.
--
-- A buyer publishes a booking page (/book/<slug>) showing when they're free.
-- An agent picks a slot and asks for a call or a viewing; the buyer accepts or
-- declines in the app, and both get a calendar invite. The public page only
-- ever goes through the API routes (service role); agents never touch these
-- tables directly.

create table if not exists booking_pages (
  user_id uuid primary key references auth.users (id) on delete cascade,
  slug text not null unique
    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  display_name text not null,
  -- Shared with the agent only once a request is accepted.
  phone text,
  intro text,
  slot_minutes integer not null default 30 check (slot_minutes in (15, 30, 45, 60)),
  min_notice_hours integer not null default 2 check (min_notice_hours between 0 and 72),
  days_ahead integer not null default 14 check (days_ahead between 1 and 60),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Weekly windows, in Europe/London wall-clock time. weekday: 1 = Mon .. 7 = Sun.
create table if not exists availability_windows (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null,
  check (end_time > start_time)
);

create index if not exists availability_windows_user on availability_windows (user_id);

create table if not exists booking_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('call', 'viewing')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  agent_name text not null,
  agent_email text not null,
  agent_phone text,
  agency text,
  property_address text,
  property_url text,
  message text,
  property_id uuid references properties (id) on delete set null,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

create index if not exists booking_requests_user_time
  on booking_requests (user_id, starts_at);

-- Two live requests can never hold the same slot for the same buyer, even if
-- two agents submit at the same moment.
create unique index if not exists booking_requests_no_double_booking
  on booking_requests (user_id, starts_at)
  where status in ('pending', 'accepted');

-- RLS: each buyer manages only their own page, windows and requests, and
-- must be a household member (see 002).
alter table booking_pages enable row level security;
alter table availability_windows enable row level security;
alter table booking_requests enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['booking_pages', 'availability_windows', 'booking_requests'] loop
    execute format('drop policy if exists own_rows on %I', t);
    execute format(
      'create policy own_rows on %I for all to authenticated
         using (user_id = auth.uid() and is_household_member())
         with check (user_id = auth.uid() and is_household_member())',
      t
    );
  end loop;
end $$;

-- One-off fix for the timezone bug: viewing times were saved from the browser
-- without a UTC offset, so a 12:30 viewing during British Summer Time was
-- stored as 12:30 UTC (13:30 London). Shift the rows saved before the fix
-- back to the time that was actually entered. Winter (GMT) rows were already
-- right. Only rows not touched since this migration was written are changed.
update property_notes
set viewing_datetime = (viewing_datetime at time zone 'UTC') at time zone 'Europe/London'
where viewing_datetime is not null
  and updated_at < '2026-11-12'
  and (viewing_datetime at time zone 'Europe/London')
      <> (viewing_datetime at time zone 'UTC');
