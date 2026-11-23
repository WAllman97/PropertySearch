-- Run once in the Supabase SQL editor.
--
-- 1. Viewing requests to agents who aren't on PropertySearch no longer need the
-- agent's email (portals hide it behind a contact form). Without one, the
-- buyer sends the agent the request link themselves: pasted into the portal's
-- "email agent" form, WhatsApp or a text (api/_lib/viewing-requests.js).

alter table viewing_requests alter column agent_email drop not null;

alter table viewing_requests drop constraint if exists viewing_requests_agent_email_check;
alter table viewing_requests add constraint viewing_requests_agent_email_check
  check (agent_email is null or char_length(agent_email) between 3 and 254);

-- 2. Email preferences and one-click unsubscribe ----------------------------
-- "New match" and "price cut" emails carry a private unsubscribe link and
-- the List-Unsubscribe header (UK PECR, and Gmail/Apple Mail one-click).
-- Push notifications and the app itself are unaffected. Service role only:
-- the unsubscribe page works by token, without a login.

create table if not exists email_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  unsubscribe_token uuid not null unique default gen_random_uuid(),
  matches boolean not null default true,      -- agents' new listings
  price_drops boolean not null default true,  -- price cuts on saved homes
  updated_at timestamptz not null default now()
);

alter table email_preferences enable row level security;

-- Each person can see and change their own (Settings), never anyone else's.
drop policy if exists own_email_preferences on email_preferences;
create policy own_email_preferences on email_preferences for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Check: agent_email nullable should say YES.
select
  (select is_nullable from information_schema.columns
    where table_name = 'viewing_requests' and column_name = 'agent_email') as agent_email_nullable,
  (select count(*) from email_preferences) as email_preferences;
