# Scaling and bug review (26 Nov 2026)

A read-through of the whole app (API, database, background jobs, screens)
asking: what breaks first as ViewPal grows to about **5,000 buyers and 500
agents**? No load test was run against the live app: that would hit the real
database, Google and Resend quotas. Each finding below was checked against
the code. Today's live size, for scale: 2 households, 3 agents, 299 saved
homes, and already **594 viewing slots from 6 listings** (about 100 per
listing).

Status column: **todo** until fixed.

Also fixed with item 11: a deleted account's photos are removed from both storage buckets, page by page.

## 1. Fix now (small changes, real risk): all fixed 26 Nov

Items 2-4 need migration `039_cleanup_and_indexes.sql` run in Supabase.

| # | Weak point | Where | What goes wrong | Fix | Status |
|---|---|---|---|---|---|
| 1 | Setup-call reminder sends the push inside the email's try | `backend/jobs/send_viewing_reminders.py` (setup calls) | If the push fails after the email went, the email is sent again next hour (up to 3x) | Push in its own best-effort try | fixed 26 Nov |
| 2 | Past viewing slots are never deleted | migrations 022/026 | ~100 rows per listing and growing; at 500 agents, millions of rows a year: the 500 MB free database fills within months | Daily delete of past slots nobody booked; also clear old `api_usage` rows | fixed 26 Nov |
| 3 | Clash check scans the agent's whole slot history | `slot_blocked()` (034) | Every free time a buyer sees runs it; it gets slower every day | Add a lower time bound and a bookings index | fixed 26 Nov |
| 4 | Missing indexes on foreign keys | 006, 010, 015, 034, 035 | Deleting a household or home scans whole tables | Six `create index` lines | fixed 26 Nov |
| 5 | Agent portal loads every booking ever, oldest first | `AgentPortal.jsx` load | Past 1,000 bookings the newest are dropped: booked viewings show as free | Only bookings for the slots on screen | fixed 26 Nov |
| 6 | Agent portal reloads can overwrite each other | `AgentPortal.jsx` load | Two quick taps: an older reload lands last and a toggle snaps back | Ignore stale reloads | fixed 26 Nov |
| 7 | Guest booking limit counts every slot a listing ever had | `api/listing-viewings.js` | Huge URL, error ignored, so the "40 bookings an hour" limit lets everything through | Count via a join, refuse if the count fails | fixed 26 Nov |
| 8 | Run-sheets read all of a day's slots, capped at 1,000 rows | `send_viewing_reminders.py` `_booked_by_agent` | With many agents the afternoon drops off run-sheets silently | Read confirmed bookings only, paged | fixed 26 Nov |
| 9 | Job workflows have no timeout or overlap guard | `.github/workflows/*.yml` | One hung email call holds the job for 6 hours while the next hourly runs pile up | `timeout-minutes` and `concurrency` | fixed 26 Nov |
| 10 | Buyer calendar uses the phone's timezone and breaks at clock changes | `CalendarView.jsx`, `ViewingDayCard.jsx`, `DashboardView.jsx` | A phone set abroad shows wrong times; around the clock change the day strip repeats a date | London timezone everywhere, step days by date | fixed 26 Nov |
| 11 | Deleting an account leaves viewing photos behind | `api/delete-account.js` | Orphaned photos fill the 1 GB storage | Remove the household's photo folder too | fixed 26 Nov |
| 12 | Trial emails need the job to run on the exact day | `agent_trial_emails.py` | A missed 9am run loses the "4 days left" email for good | Send when "4 or fewer days left and not sent yet" | fixed 26 Nov |

## 2. Needs a decision first

| # | Weak point | Decision |
|---|---|---|
| 13 | **Any agent can list any home** (even a trial agent with no code), then sees the buyers who book it, with their buying position | Allow only one active agent per home? Joint agents exist, so maybe "second agent needs approval on /admin" |
| 14 | **Guest booking form needs no login**: a script can fill a listing's diary and send emails to any address typed in | Add a captcha (Cloudflare Turnstile is free) or an email-confirm step before the booking holds the slot |
| 15 | **Buyer sign-up cap is app-wide** (30 an hour): a script can block all real sign-ups | Per-IP limit or captcha |
| 16 | **Email volume vs Resend**: rough estimate 1-2 emails a day per active buyer and up to 2 per agent. The free plan (100/day) runs out at about 50 active buyers; Pro (50k/month) at roughly 700-1,000 | Upgrade Resend before launch; consider a daily digest of new matches instead of one email per listing |
| 17 | **Sending a listing to many buyers** fires every email at once: Resend rate-limits most, failures are silent, and those buyers are marked "sent" so never get it | Move sends to a queue table worked by a job, mark sent only after success |
| 18 | **Price cuts** find saved copies with a `%id%` text search and update them one by one: slow, capped at 1,000, can time out half-way | Store an indexed listing key on saved homes and update in bulk |

## 3. Bigger work for later (fine for the first few hundred users)

- **Database security checks run per row.** The notes and bookings access
  rules call a function per row and some screens read without a filter;
  slow past ~100k rows. Add `household_id` / `agent_id` columns and simpler
  rules.
- **Buyer-search matching scans every search.** Fine at hundreds, slow at
  tens of thousands. Split the area, radius and map-drawn cases so each uses
  an index.
- **`admin_metrics`** grows with agents × bookings; will time out eventually.
- **Saved homes copy bulky text per household.** Store descriptions and
  comps once per listing.
- **Nightly backup downloads every file each night**, one by one, into a
  20-minute job and keeps 30 copies on GitHub. Move files to incremental
  backup (e.g. Cloudflare R2) and keep only the database dump on GitHub.
- **Sold-price comps** handle 60 homes a day; at scale they fall months
  behind. Compute once per listing or postcode and share.
- **Google Routes cost**: about 1-2 paid calls per saved home, more when
  profiles are re-saved. At 5,000 buyers roughly $500 a month. Only refresh
  when the address or travel mode really changed; cache by origin and
  destination; keep a daily quota on the key.
- **App size**: one 754 KB script. Loading the agent portal and the public
  link pages separately would roughly halve what a buyer or an agent opening
  an email link downloads.
- **Agent portal refetches everything after each tap** (12 queries plus a
  slot sync), and renders hidden tabs and full-size photos. Fine at a few
  listings, slow at 80.
- **Dashboard and home lists load whole tables** (capped at 1,000 rows,
  silently). Count in the database and page the lists.
- **Claim-then-send jobs**: if a run is killed between claiming and sending,
  that reminder is never sent. Add a "claimed but unsent after 30 minutes"
  retry.
- **Push failures are silent**: if Apple rejects the key, nothing alerts.
- Pin `react`, `vite` and `supabase-js` versions instead of `latest`.

## Checked and fine

- Signed-in routes check ownership; no secrets in responses.
- Database functions set `search_path`; service-only ones are locked down.
- `book_viewing` locks per agent, so two buyers can't take the same time.
- Times are stored as real instants; jobs handle London time and clock
  changes correctly.
