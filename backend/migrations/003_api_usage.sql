-- Rate-limit log for the Vercel API routes (frontend/api/_lib/household.js).
-- Run once in the Supabase SQL editor, after 002.

create table if not exists api_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now()
);

create index if not exists api_usage_lookup
  on api_usage (user_id, action, created_at desc);

-- Only the service role (used by the API routes) touches this table.
alter table api_usage enable row level security;
