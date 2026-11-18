-- Push notifications: run once in the Supabase SQL editor.
--
-- One row per phone that has turned notifications on in the iPhone app. The
-- token is Apple's (APNs) address for that phone; the server sends to it
-- when a matching listing arrives or a viewing is tomorrow.

create table if not exists device_tokens (
  -- APNs device tokens are hex (64 chars today; Apple says don't assume).
  token text primary key check (token ~ '^[0-9a-f]{64,200}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null default 'ios' check (platform in ('ios')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists device_tokens_user_idx on device_tokens (user_id);

alter table device_tokens enable row level security;

-- Users can see and remove their own phones. Adding goes through
-- register_device_token so a phone that changes hands (sign out, someone
-- else signs in) moves to the new account instead of failing on the key.
drop policy if exists own_device_tokens_read on device_tokens;
create policy own_device_tokens_read on device_tokens
  for select to authenticated using (user_id = auth.uid());

drop policy if exists own_device_tokens_delete on device_tokens;
create policy own_device_tokens_delete on device_tokens
  for delete to authenticated using (user_id = auth.uid());

create or replace function register_device_token(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  insert into device_tokens (token, user_id, last_seen_at)
  values (lower(p_token), auth.uid(), now())
  on conflict (token) do update
    set user_id = excluded.user_id, last_seen_at = now();
end;
$$;

create or replace function unregister_device_token(p_token text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from device_tokens where token = lower(p_token) and user_id = auth.uid();
$$;

revoke all on function register_device_token(text) from public, anon;
revoke all on function unregister_device_token(text) from public, anon;
grant execute on function register_device_token(text) to authenticated;
grant execute on function unregister_device_token(text) to authenticated;
