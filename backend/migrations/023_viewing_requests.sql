-- Viewing requests to agents who aren't on PropertySearch: run in the
-- Supabase SQL editor, after 022. Safe to run again.
--
-- A buyer picks up to three times for a saved home and we email the agent a
-- private link (/request/<token>). With no account, the agent confirms one
-- of the times, suggests another, or declines. A confirmed time goes into the
-- household calendar (property_notes), which also drives the reminders.
--
-- Everything is written by /api/viewings with the service role. Household
-- members can read their own requests; agents only ever see one request,
-- through its token.

create table if not exists viewing_requests (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  property_id uuid not null references properties (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  buyer_name text not null check (char_length(buyer_name) between 1 and 100),
  buyer_email text not null check (char_length(buyer_email) <= 254),
  buyer_phone text check (char_length(buyer_phone) <= 40),
  agent_email text not null check (char_length(agent_email) between 3 and 254),
  agent_name text check (char_length(agent_name) <= 100),
  message text check (char_length(message) <= 500),
  -- The buyer's suggested start times (1 to 3).
  options timestamptz[] not null
    check (cardinality(options) between 1 and 3),
  duration_minutes smallint not null default 30 check (duration_minutes in (15, 20, 30, 45, 60)),
  -- pending: waiting for the agent
  -- proposed: the agent suggested another time, waiting for the buyer
  -- confirmed: agreed (confirmed_start)
  -- declined: the agent can't do it
  -- cancelled: the buyer withdrew it
  status text not null default 'pending'
    check (status in ('pending', 'proposed', 'confirmed', 'declined', 'cancelled')),
  confirmed_start timestamptz,
  proposed_start timestamptz,
  agent_note text check (char_length(agent_note) <= 500),
  -- The agent's private link.
  token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  updated_at timestamptz not null default now(),
  check (status <> 'confirmed' or confirmed_start is not null),
  check (status <> 'proposed' or proposed_start is not null)
);

create unique index if not exists viewing_requests_token on viewing_requests (token);
create index if not exists viewing_requests_household on viewing_requests (household_id, created_at desc);
create index if not exists viewing_requests_agent_email on viewing_requests (lower(agent_email), created_at desc);

-- One open request per home at a time.
create unique index if not exists viewing_requests_one_open
  on viewing_requests (property_id) where status in ('pending', 'proposed');

alter table viewing_requests enable row level security;

drop policy if exists household_read on viewing_requests;
create policy household_read on viewing_requests
  for select to authenticated
  using (household_id = current_household_id());

-- Agents who asked not to be sent requests (link at the foot of each email).
create table if not exists viewing_request_opt_outs (
  email text primary key check (email = lower(email) and char_length(email) <= 254),
  created_at timestamptz not null default now()
);

alter table viewing_request_opt_outs enable row level security;
-- No policies: only the API (service role) reads or writes it.

-- Check
select (select count(*) from viewing_requests) as viewing_requests,
       (select count(*) from viewing_request_opt_outs) as opt_outs;
