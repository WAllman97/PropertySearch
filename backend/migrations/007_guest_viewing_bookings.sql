-- Guest viewing bookings: run once in the Supabase SQL editor, after 006.
--
-- Agents can share a public link per listing (/viewings/<listing id>), so any
-- buyer can book one of their times without a PropertySearch account. Guest
-- bookings have no buyer_id; the guest cancels with the private link in their
-- confirmation email (cancel_token).

alter table viewing_bookings alter column buyer_id drop not null;

alter table viewing_bookings
  add column if not exists cancel_token uuid not null default gen_random_uuid();

create unique index if not exists viewing_bookings_cancel_token
  on viewing_bookings (cancel_token);

-- Same as 006, but a null p_buyer means a guest, and "already booked" is also
-- matched on email so one person can't take every space on a listing.
create or replace function book_viewing(
  p_slot uuid,
  p_buyer uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_property uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s viewing_slots;
  taken integer;
  new_id uuid;
begin
  select * into s from viewing_slots where id = p_slot for update;

  if not found or s.cancelled_at is not null then
    raise exception 'SLOT_GONE';
  end if;

  if s.starts_at <= now() then
    raise exception 'SLOT_PAST';
  end if;

  if exists (
    select 1
    from viewing_bookings b
    join viewing_slots other on other.id = b.slot_id
    where b.status = 'confirmed'
      and other.listing_id = s.listing_id
      and other.cancelled_at is null
      and other.starts_at > now()
      and (
        (p_buyer is not null and b.buyer_id = p_buyer)
        or lower(b.buyer_email) = lower(p_email)
      )
  ) then
    raise exception 'ALREADY_BOOKED';
  end if;

  select count(*) into taken
  from viewing_bookings
  where slot_id = p_slot and status = 'confirmed';

  if taken >= s.capacity then
    raise exception 'SLOT_FULL';
  end if;

  insert into viewing_bookings (slot_id, buyer_id, property_id, buyer_name, buyer_email, buyer_phone)
  values (p_slot, p_buyer, p_property, p_name, p_email, nullif(p_phone, ''))
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function book_viewing(uuid, uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function book_viewing(uuid, uuid, text, text, text, uuid) to service_role;
