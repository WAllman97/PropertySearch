# ViewPal: project status

_Reconstructed on 22 Nov 2026 from the git history. The Claude chats for 12–20 Nov were lost when the work PC was restored to an 11 Nov image; the code and commits were not affected. Last commit: 20 Nov, `03dab2a` (main = `fix/review-findings`, identical trees)._

## What the product is now

A house-hunting app for buyers, with a portal for estate agents, heading for the iPhone App Store.

- **Buyers** save homes, see a filtered and scored view, book calls and viewings, track offers, and share all of it with a partner.
- **Agents** publish viewing times, send listings to buyers whose searches match, confirm offers, and are billed per branch.
- **No scraping.** The original single-user tool's daily portal scrape, daily email and AI scoring were removed on 23 Nov 2026 ahead of App Store submission. Nothing reads a portal on a schedule; see `docs/DATA_SOURCES.md`.

## Timeline of what was built

### Up to 11 Nov (PR #2)
AI triage scoring; the agent call/viewing booking page (`/book/<slug>`); the security lockdown (row-level security allow-list, API rate limits); the BST viewing-time fix; forgot password; commutes for the preferred mode only.

### 12–13 Nov: market data and agent viewings
- **Commutes:** stop routing when Google rejects the API key (401/403), as well as on quota (429).
- **Price data (migration 005):** asking-price history, reduction dates, time on market, off-market status; Rightmove sold prices matched on bedrooms, with an HM Land Registry fallback. Shown as card badges and filters, and in the daily email.
- **Agent accounts (`/agent`, migration 006):** agents publish viewing slots, buyers book in two clicks, either side can cancel, calendar invites both ways.
- **Guest booking (migration 007):** public page per listing (`/viewings/<id>`), so buyers can book without an account and cancel by email link.
- **Viewing reminders fixed (migration 008):** the missing `reminder_sent_at` column meant no reminders had ever been sent.

### 17–18 Nov: iPhone app, buyer searches, multi-household
- **iPhone app:** Capacitor iOS project, bundle ID `com.wallman97.propertysearch`, icons and launch screen, `/privacy` page, in-app account deletion (an Apple requirement). See `docs/IOS_APP.md`.
- **Buyer searches (migration 009):** postcodes, price, beds, type, garden. The first step towards replacing scraping.
- **Agent → buyer matching (migration 010):** agents see "N buyers match" and send a listing to them, with each buyer claimed once.
- **Save by pasting a link:** `/api/lookup` fills in the details from a shared cache (migration 011). Zoopla falls back to typing the details in.
- **Push notifications (migration 012):** new matches, viewing reminders, price drops, booking requests. They need the `APNS_KEY`, `APNS_KEY_ID` and `APNS_TEAM_ID` secrets.
- **Households (migrations 013 and 014):**
  - Sign-up is open, and each account gets its own household. A partner joins through an invite link.
  - Every API route and job filters data by household itself, because the service role bypasses row-level security.
  - Migration 014 dropped the old dashboard policies that left all homes open.

### 19 Nov: buying position, maps, admin, agent onboarding, mobile UI
- **Buying position and offers (migration 015):** buyers declare funding, chain, solicitor and timeframe. An offer counts as "accepted" once the agent confirms it.
- **Search by area (migration 016):** "within X miles of a place" or a shape drawn on a map, using postcodes.io and Leaflet.
- **Proof documents (migration 017):** one private upload per household (agreement in principle, mortgage offer or proof of funds). Agents can view it only if they have a booking or offer with the buyer and the buyer has sharing on.
- **Admin dashboard (`/admin`, migration 018):** launch KPIs against quarterly targets. Only accounts in `app_admins` can see it.
- **Agent onboarding (migrations 019 to 021):** a public `/agents` page; sign-up codes per branch (e.g. `BROOKS-WANDSWORTH-7F3A2`) with a set number of seats; billing per branch.
- **TestFlight:** the `ios-testflight.yml` workflow builds the app on a cloud Mac and signs it with an App Store Connect API key.
- **Vercel's 12-function limit:** the place and postcode lookups merged into `/api/lookup`, and the build fails if `api/` goes over 12 again.
- **UX:**
  - Dashboard is now a "what needs my attention" page.
  - "Tidy up" archives sold and off-market homes, with undo.
  - Properties and Watchlist show compact flip tiles.
  - Phone layout: bottom tab bar, agenda-style calendar, sections that collapse.
  - New buyers get a getting-started checklist.

### 20 Nov: App Store readiness
- **Agent weekly hours (migration 022):** agents set their viewing hours once and bookable slots are generated from them, allowing travel time between homes.
- **Email confirmation:** required for new accounts, with branded emails sent through Resend (`/confirm`). The password-reset template is in `docs/email-templates/`.
- **App Review:** demo accounts from `scripts/seed-demo.mjs` (passwords are in the git-ignored `docs/app-review-logins.local.md`), plus 9 screenshots in `docs/app-store/screenshots`.
- **Nightly backups:** `nightly-backup.yml` dumps the database and stored files, encrypted with `BACKUP_PASSPHRASE`, kept for 30 days. See `docs/BACKUPS.md`.
- **Viewing requests to agents not on the app (migration 023):** the agent confirms a time through a private link at `/request/<token>`, with no account needed.
- **Saving homes from other apps:** an iPhone share extension, plus a Paste button in Add Property.
- **Watchlist sorting:** date, price, score, progress, price cut, time on market.
- **Portal policy:** portals are read only as link previews of a page the buyer pastes. Price cuts for app users come from agents updating prices in the agent portal.

### 24 Nov: must-haves and viewing notes
- **Must-haves (migration 031):** Settings → "Your must-haves" is the household's dealbreaker list. At each viewing the buyer ticks every one ✓ / ✗ (stored in `property_notes.checklist`), with free-text viewing notes. Watchlist tiles show "✗ 1 must-have missing" or "✓ 4 of 5".
- **Viewing notes tidied:** a home's notes page shows the booked viewing (date, agent, phone, email, filled in by the booking) as a summary with "Change", instead of empty boxes; then must-haves and notes, the score, and pros/cons. Saving notes no longer writes over the viewing details unless they were changed by hand.
- **Calendar → notes:** tapping a viewing shows the must-have ticks and notes inline (to fill in during the viewing) and a "Notes & scoring" button that opens that home. The Dashboard's "How did it go?" opens the home too.

### 25 Nov: renamed to ViewPal
- The product is now **ViewPal** (was PropertySearch). Name checks on 25 Nov: no "ViewPal" company at Companies House (only VIEWPALM LIMITED); the only trade mark worldwide in WIPO's database is GE Healthcare's in Japan (class 9, medical imaging); no ViewPal app on the UK or US App Store. viewpal.com belongs to someone else (a holding page). Will owns **viewpal.app** (main address) and **viewpal.co.uk** (redirects to it and also receives email).
- **iPhone:** the bundle ID stays `com.wallman97.propertysearch` (decided 25 Nov: users never see it, and keeping it avoids a new App Store Connect record and TestFlight reinstalls). Only the names changed: the identifier's name in the developer portal, and the app's name in App Store Connect. URL scheme `viewpal://` (the app still accepts `propertysearch://`).
- **Web address:** code defaults now point at `https://viewpal.app`. The iPhone app calls the API there, so `viewpal.app` must be live on Vercel before the next iPhone build. Universal links and the app keep accepting the old `property-search-4jcc.vercel.app` links already in people's inboxes.
- **Email:** the contact address is `hello@viewpal.app`; addresses at either domain are treated as ours. The demo App Review accounts stay on `@viewpal.co.uk`.
- **To do for the rename:**
  - Vercel: add `viewpal.app` and `www.viewpal.app`, plus `viewpal.co.uk` as a redirect.
  - Supabase Auth: set the Site URL and redirect URLs to `viewpal.app`.
  - Resend: verify `viewpal.app`, then set `FROM_EMAIL` (e.g. `ViewPal <bookings@viewpal.app>`) in both Vercel and GitHub.
  - Google Workspace for the inboxes.
  - Rename the GitHub repo and the Vercel project if you want.

### 26 Nov: agents book their own setup call
- **Setup calls (migration 038):** trial agents tap "Book your setup call" on the trial banner (or "Book a call" in the trial emails, which opens `/agent?call=1`), pick a day and time, choose phone or video, and it's booked. They can move or cancel it from the banner. "Ask us to ring you" (the old request-a-call form) stays as a fallback.
- **Free times** = the hours on `/admin` → Setup calls (weekdays 9:00–17:30 to start, 15-minute calls, 2 hours' notice, 14 days ahead), minus calls already booked, minus anything busy in Will's ViewPal Google calendar. The calendar is read from its secret iCal address in the Vercel variable `CALL_CALENDAR_ICS_URL` (`frontend/api/_lib/calendar-feed.js`, using `ical.js`; repeating meetings are expanded, events marked Free are ignored). If the link is set but can't be read, agents see no times rather than risk a clash.
- **Emails:** each booking, move and cancel emails the agent and `ADMIN_EMAIL` (or hello@) with a calendar invite. The hourly reminders job emails and notifies the agent up to 3 hours before the call.
- **Video calls:** offered only when a Google Meet link is saved on `/admin`.
- **To switch it on:** run migration 038; add `CALL_CALENDAR_ICS_URL` in Vercel and redeploy; check `/admin` → Setup calls says "Linked".

## Architecture

| Part | Where | Notes |
|---|---|---|
| Web app | `frontend/` (React + Vite), Vercel | Also wrapped as the iOS app via Capacitor |
| API | `frontend/api/*.js` (12 Vercel functions max), shared code in `frontend/api/_lib/` | Service-role Supabase client, so every route checks the household itself |
| Jobs | `backend/` (Python), GitHub Actions | Viewing reminders and agent run sheets, Land Registry sold-price comparisons, nightly backup |
| Database | Supabase (Postgres, row-level security, storage) | Migrations in `backend/migrations/` 001–031 |
| Email / push | Resend / APNs | |

**Workflows:** `viewing-reminders.yml` (hourly), `sold-price-comps.yml` (daily 06:00 UTC), `ios-testflight.yml` (manual), `nightly-backup.yml`.

## Open items and things to check
- **Migrations applied?** Confirm 005–023 are applied in Supabase. The commits say 008 was; the rest weren't recorded.
- **Google Routes:** commutes were failing on a 100-a-day quota (429) and on key permissions (403). Checked 26 Nov: the 403s have stopped and new homes get commutes again (latest one today succeeded). Still worth a look in Google Cloud → APIs & Services → Routes API → Quotas: confirm the daily ComputeRoutes limit is comfortably above 100, and set a billing budget alert so a bug can't run up a bill.
- **Vercel:** the live project `property-search-4jcc` needs Root Directory `frontend`, the default build commands, and its environment variables set for Preview as well. The duplicate `property-search` project should be disconnected.
- **Secrets used by the newer features:**
  - APNs (`APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`): **set** in both GitHub and Vercel. The key is `X74MYGJ3ZQ`, made 19 Nov, and the `.p8` is in OneDrive under Personal Drive → Property Search Keys.
  - TestFlight: the App Store Connect API key secrets are **set** (22 Nov), and the GitHub workflow is the normal way to build.
  - Backups: **set and working**. The nightly backup has succeeded every night from 21 to 26 Nov (its first step fails the run if either secret is missing or malformed). Make sure `BACKUP_PASSPHRASE` is also in your password manager, and try one restore (docs/BACKUPS.md) before launch.
  - Optional: `AGENT_SIGNUP_CODE`.
- **iPhone app:** it runs on Will's iPhone, the first TestFlight upload (from a borrowed Mac) went through on 22 Nov, and the share extension is still to be tested. Still to do: an external TestFlight group for the agent demo, and the App Store submission.
- **Sign-ups:** these are now deliberately open (households plus email confirmation), which replaces the earlier advice to switch them off.
- **Repo location:** the repo lives in a OneDrive/SharePoint-synced folder. Syncing `.git` this way can corrupt it, so move it out and use GitHub to move work between computers.
- **"Cash rec – refresh" scheduled task:** it creates a new Claude session every 5 minutes and floods the session list. Change it, and archive the old sessions (6 of about 487 done).
