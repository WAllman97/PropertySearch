-- One-tap booking from a "new match" email: run once in the Supabase SQL editor.
--
-- Each buyer an agent sends a listing to gets their own link,
-- /viewings/<listing id>?b=<book_token>. The token tells the booking page who
-- they are, so their name, email and phone are already filled in and the
-- booking goes into their PropertySearch calendar. The token works only for
-- that one listing, and only the buyer it was emailed to has it.

alter table listing_sends
  add column if not exists book_token uuid not null default gen_random_uuid();

create unique index if not exists listing_sends_book_token on listing_sends (book_token);

-- Check: every send has a token.
select count(*) as sends, count(book_token) as with_token from listing_sends;
