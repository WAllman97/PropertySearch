-- Proof for a buying position: run once in the Supabase SQL editor, after 016.
--
-- A household can attach one document to its buying position: a mortgage
-- agreement in principle, a full mortgage offer, or proof of funds for a
-- cash buyer. It lives in a private storage bucket, in a folder named after
-- the household. Agents can open it only on the same terms as the position
-- itself (migration 015): the buyer booked a viewing or reported an offer
-- with them, and the household shares its position. Agents can open only the
-- current document, never list the folder or see replaced ones.
--
-- The document isn't checked by PropertySearch: agents see "provided by the
-- buyer" and judge it themselves.

-- 1. Where the current document is ---------------------------------------------

alter table buyer_positions
  add column if not exists proof_path text,
  add column if not exists proof_name text check (char_length(proof_name) <= 200),
  add column if not exists proof_uploaded_at timestamptz;

-- "<household id>/<random id>.<ext>", inside the household's own folder.
alter table buyer_positions drop constraint if exists buyer_positions_proof_path_check;
alter table buyer_positions add constraint buyer_positions_proof_path_check check (
  proof_path is null
  or (proof_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|jpg|jpeg|png|heic)$'
      and split_part(proof_path, '/', 1) = household_id::text)
);

-- 2. Private bucket: PDF or photo, up to 10 MB -----------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('position-proofs', 'position-proofs', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/heic'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 3. Who may open a document -----------------------------------------------------

-- Buyers the calling agent has dealings with (same rule as
-- agent_buyer_positions in 015).
create or replace function agent_buyer_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select b.buyer_id
  from viewing_bookings b
  join viewing_slots s on s.id = b.slot_id
  where s.agent_id = auth.uid() and b.buyer_id is not null
  union
  select o.reported_by
  from offers o
  join agent_listings l on l.id = o.agent_listing_id
  where l.agent_id = auth.uid() and o.reported_by is not null;
$$;

-- Is this storage object the current, shared proof of a buyer the calling
-- agent deals with?
create or replace function agent_can_open_proof(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from buyer_positions p
    join household_members m on m.household_id = p.household_id
    where p.proof_path = object_name
      and p.share_with_agents
      and m.user_id in (select agent_buyer_ids())
  );
$$;

revoke all on function agent_buyer_ids() from public, anon;
grant execute on function agent_buyer_ids() to authenticated;
revoke all on function agent_can_open_proof(text) from public, anon;
grant execute on function agent_can_open_proof(text) to authenticated;

-- Household members: upload, open, replace and delete in their own folder.
drop policy if exists "position proofs: household" on storage.objects;
create policy "position proofs: household" on storage.objects
  for all to authenticated
  using (bucket_id = 'position-proofs'
         and (storage.foldername(name))[1] = current_household_id()::text)
  with check (bucket_id = 'position-proofs'
              and (storage.foldername(name))[1] = current_household_id()::text);

-- Agents: open (not list, change or delete) the current shared proof only.
drop policy if exists "position proofs: agents" on storage.objects;
create policy "position proofs: agents" on storage.objects
  for select to authenticated
  using (bucket_id = 'position-proofs' and agent_can_open_proof(name));

-- 4. Agents' view of positions now says whether there's a document ------------

drop function if exists agent_buyer_positions();
create function agent_buyer_positions()
returns table (
  buyer_id uuid,
  proceedable boolean,
  max_budget integer,
  buying_with text,
  mortgage_status text,
  aip_amount integer,
  aip_lender text,
  aip_expires date,
  selling_status text,
  solicitor_ready boolean,
  move_timeframe text,
  updated_at timestamptz,
  proof_path text,
  proof_uploaded_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.user_id,
    position_is_proceedable(p),
    p.max_budget, p.buying_with, p.mortgage_status, p.aip_amount, p.aip_lender,
    p.aip_expires, p.selling_status, p.solicitor_ready, p.move_timeframe, p.updated_at,
    p.proof_path, p.proof_uploaded_at
  from (select distinct id from agent_buyer_ids() as id) mb
  join household_members m on m.user_id = mb.id
  join buyer_positions p on p.household_id = m.household_id
  where p.share_with_agents;
$$;

revoke all on function agent_buyer_positions() from public, anon;
grant execute on function agent_buyer_positions() to authenticated;

-- 5. Check ----------------------------------------------------------------------

select id, public, file_size_limit, allowed_mime_types
from storage.buckets where id = 'position-proofs';
