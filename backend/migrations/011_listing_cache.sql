-- Save-a-link: run once in the Supabase SQL editor.
--
-- When a buyer pastes a Rightmove / OnTheMarket / Zoopla link, /api/listing-
-- preview reads that one page (like a link preview) and stores what it found
-- here, keyed by listing_key(url). Anyone else saving the same listing gets
-- the stored copy, so each listing is fetched once, not once per user, and
-- nothing crawls the portals.

create table if not exists listing_cache (
  listing_key text primary key,
  -- ok: details parsed; blocked: the portal refused (Zoopla does);
  -- failed: page gone or unreadable. Non-ok entries are retried sooner.
  status text not null check (status in ('ok', 'blocked', 'failed')),
  details jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now()
);

-- Service role only (the API route). No policies: clients can't read it.
alter table listing_cache enable row level security;
