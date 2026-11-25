-- Run once in the Supabase SQL editor (after 034).
--
-- 1. One-tap viewing feedback. After a viewing the buyer answers "How was
--    it?" with Not for us / Maybe / Want a second look, plus an optional
--    one-line note (viewing_feedback). The household reads its own; writes
--    go through save_viewing_feedback(), which links the answer to the app
--    booking behind it, so a household can't attach feedback to someone
--    else's booking. Agents read feedback on their own listings through
--    agent_viewing_feedback() (no direct access to the table).
--    viewing_bookings.feedback_asked_at: the hourly job asks once, ~2 hours
--    after the viewing ends (claim-before-send, like reminder_sent_at).
-- 2. Seller report: a private link per listing (/report/<report_token>) the
--    agent sends the vendor. Read only by the server (api/send-listing.js),
--    which returns counts, dates, anonymised feedback, offers and prices,
--    never buyers' names or contact details. listing_price_history records
--    every asking price from now on (seeded from what we already know).
-- 3. Agents' evening run-sheet ("Tomorrow: 4 viewings", once per evening:
--    agents.evening_sheet_sent_on) and a "New today" push for bookings made
--    after the morning run-sheet (agents.runsheet_sent_at says when that
--    was; viewing_bookings.agent_notified_late_at stops a second push).
-- 4. Open house needs nothing new: viewing_slots.capacity (006) is already
--    checked by book_viewing and returned by available_viewings.
-- 5. branch_stats(p_since): this month's numbers for every agent on the
--    caller's branch sign-up code, as totals only (never per agent or buyer).
--
-- Safe to run more than once.

-- 1. Viewing feedback --------------------------------------------------------

create table if not exists viewing_feedback (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  property_id uuid not null references properties (id) on delete cascade,
  -- The PropertySearch booking it was about (null for viewings booked by
  -- phone and typed into the calendar by hand: the buyer still gets asked).
  booking_id uuid references viewing_bookings (id) on delete set null,
  viewing_at timestamptz not null,
  answer text not null check (answer in ('not_for_us', 'maybe', 'second_look')),
  note text check (length(note) <= 140),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One answer per viewing; answering again changes it.
  unique (household_id, property_id, viewing_at)
);
create index if not exists viewing_feedback_booking on viewing_feedback (booking_id);

alter table viewing_feedback enable row level security;

drop policy if exists household_read on viewing_feedback;
create policy household_read on viewing_feedback
  for select to authenticated
  using (household_id = current_household_id());

alter table viewing_bookings add column if not exists feedback_asked_at timestamptz;

-- Save (or change) the household's answer for one viewing.
create or replace function save_viewing_feedback(
  p_property uuid,
  p_viewing_at timestamptz,
  p_answer text,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  hh uuid := current_household_id();
  found_booking uuid;
  saved uuid;
begin
  if hh is null then
    raise exception 'NOT_ALLOWED';
  end if;
  if p_answer not in ('not_for_us', 'maybe', 'second_look') then
    raise exception 'BAD_ANSWER';
  end if;
  if not exists (select 1 from properties where id = p_property and household_id = hh) then
    raise exception 'NOT_FOUND';
  end if;
  if p_viewing_at is null or p_viewing_at > now() then
    raise exception 'NOT_YET';
  end if;

  -- The app booking for this viewing, made by anyone in the household.
  select b.id into found_booking
  from viewing_bookings b
  join viewing_slots s on s.id = b.slot_id
  join household_members m on m.user_id = b.buyer_id and m.household_id = hh
  where b.property_id = p_property
    and b.status = 'confirmed'
    and abs(extract(epoch from (s.starts_at - p_viewing_at))) < 3600
  order by abs(extract(epoch from (s.starts_at - p_viewing_at)))
  limit 1;

  insert into viewing_feedback (household_id, property_id, booking_id, viewing_at, answer, note)
  values (hh, p_property, found_booking, p_viewing_at, p_answer, nullif(left(btrim(coalesce(p_note, '')), 140), ''))
  on conflict (household_id, property_id, viewing_at) do update
    set answer = excluded.answer,
        note = excluded.note,
        booking_id = coalesce(excluded.booking_id, viewing_feedback.booking_id),
        updated_at = now()
  returning id into saved;

  return saved;
end;
$$;

revoke all on function save_viewing_feedback(uuid, timestamptz, text, text) from public, anon;
grant execute on function save_viewing_feedback(uuid, timestamptz, text, text) to authenticated;

-- Feedback on the calling agent's own listings (only for app bookings; the
-- agent already sees those buyers' names on the booking).
create or replace function agent_viewing_feedback()
returns table (
  booking_id uuid,
  listing_id uuid,
  buyer_id uuid,
  buyer_name text,
  buyer_email text,
  viewing_at timestamptz,
  answer text,
  note text,
  answered_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select f.booking_id, s.listing_id, b.buyer_id, b.buyer_name, b.buyer_email,
         s.starts_at, f.answer, f.note, f.updated_at
  from viewing_feedback f
  join viewing_bookings b on b.id = f.booking_id
  join viewing_slots s on s.id = b.slot_id
  where s.agent_id = auth.uid()
  order by f.updated_at desc
  limit 500;
$$;

revoke all on function agent_viewing_feedback() from public, anon;
grant execute on function agent_viewing_feedback() to authenticated;

-- 2. Seller report -------------------------------------------------------------

alter table agent_listings
  add column if not exists report_token uuid not null default gen_random_uuid();
create unique index if not exists agent_listings_report_token on agent_listings (report_token);

-- Every asking price a listing has had. Server only (no policies).
create table if not exists listing_price_history (
  id bigint generated always as identity primary key,
  listing_id uuid not null references agent_listings (id) on delete cascade,
  price integer not null check (price > 0),
  changed_at timestamptz not null default now()
);
create index if not exists listing_price_history_listing on listing_price_history (listing_id, changed_at);
alter table listing_price_history enable row level security;

create or replace function record_listing_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.price is not null and (tg_op = 'INSERT' or new.price is distinct from old.price) then
    insert into listing_price_history (listing_id, price) values (new.id, new.price);
  end if;
  return new;
end;
$$;

revoke all on function record_listing_price() from public, anon, authenticated;

drop trigger if exists listing_price_history_record on agent_listings;
create trigger listing_price_history_record
  after insert or update of price on agent_listings
  for each row execute function record_listing_price();

-- Seed listings with no history yet: the price before the last cut (if any)
-- from when it was listed, then today's price.
insert into listing_price_history (listing_id, price, changed_at)
select l.id, l.previous_price, l.created_at
from agent_listings l
where l.previous_price is not null
  and not exists (select 1 from listing_price_history h where h.listing_id = l.id);

insert into listing_price_history (listing_id, price, changed_at)
select l.id, l.price,
       case when l.previous_price is not null then coalesce(l.price_reduced_at, now()) else l.created_at end
from agent_listings l
where l.price is not null
  and not exists (select 1 from listing_price_history h where h.listing_id = l.id and h.price = l.price);

-- 3. Run-sheets ----------------------------------------------------------------

alter table agents add column if not exists evening_sheet_sent_on date;
alter table agents add column if not exists runsheet_sent_at timestamptz;
alter table viewing_bookings add column if not exists agent_notified_late_at timestamptz;

-- 5. Branch numbers ------------------------------------------------------------

-- Totals since p_since for every agent sharing the caller's sign-up code.
-- One row; agents = 0 when the caller has no code (the app hides the card
-- unless agents >= 2). Minutes use the same estimates as agent_time_saved.
create or replace function branch_stats(p_since timestamptz)
returns table (
  agents integer,
  bookings integer,
  homes_sent integer,
  viewings_done integer,
  feedback_received integer,
  offers integer,
  minutes_saved integer
)
language sql
stable
security definer
set search_path = public
as $$
  with branch as (
    select a.user_id
    from agents a
    join agents me on me.user_id = auth.uid()
    where me.signup_code is not null and a.signup_code = me.signup_code
  ),
  bk as (
    select b.*, s.ends_at
    from viewing_bookings b
    join viewing_slots s on s.id = b.slot_id
    where s.agent_id in (select user_id from branch)
  ),
  n as (
    select
      (select count(*)::int from branch) as agents,
      (select count(*)::int from bk where bk.created_at >= p_since) as bookings,
      (select count(*)::int from bk where bk.cancelled_by = 'buyer' and bk.cancelled_at >= p_since) as cancellations,
      (select count(*)::int from listing_sends x join agent_listings l on l.id = x.listing_id
        where l.agent_id in (select user_id from branch) and x.sent_at >= p_since) as homes_sent,
      (select count(*)::int from bk
        where bk.status = 'confirmed' and bk.buyer_id is not null
          and bk.ends_at >= p_since and bk.ends_at < now()) as viewings_done,
      (select count(*)::int from bk
        where bk.status = 'confirmed' and bk.buyer_id is not null
          and bk.ends_at >= p_since and bk.ends_at < now()
          and exists (select 1 from viewing_feedback f where f.booking_id = bk.id)) as feedback_received,
      (select count(*)::int from offers o join agent_listings l on l.id = o.agent_listing_id
        where l.agent_id in (select user_id from branch) and o.reported_at >= p_since
          and o.status <> 'withdrawn') as offers,
      (select count(*)::int from offers o join agent_listings l on l.id = o.agent_listing_id
        where l.agent_id in (select user_id from branch) and o.agent_responded_at >= p_since) as offers_answered,
      (select coalesce(sum(a.count), 0)::int from agent_activity a
        where a.agent_id in (select user_id from branch) and a.kind = 'buyers_skipped'
          and a.created_at >= p_since) as skipped
  )
  select agents, bookings, homes_sent, viewings_done, feedback_received, offers,
         bookings * 10 + cancellations * 5 + homes_sent * 2 + offers_answered * 5 + skipped * 3
  from n;
$$;

revoke all on function branch_stats(timestamptz) from public, anon;
grant execute on function branch_stats(timestamptz) to authenticated;

-- Check: the table exists, every listing has a report link, prices are seeded.
select (select count(*) from viewing_feedback) as feedback, (select count(*) from agent_listings where report_token is not null) as report_links, (select count(*) from listing_price_history) as prices_recorded;
