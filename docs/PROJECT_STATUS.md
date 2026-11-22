# PropertySearch: project status

_Reconstructed on 22 Nov 2026 from the git history. The Claude chats for 12–20 Nov were lost when the work PC was restored to an 11 Nov image; the code and commits were not affected. Last commit: 20 Nov, `03dab2a` (main = `fix/review-findings`, identical trees)._

## What the product is now

A house-hunting app for buyers, with a portal for estate agents, heading for the iPhone App Store.

- **Buyers** save homes, see a filtered and scored view, book calls and viewings, track offers, and share all of it with a partner.
- **Agents** publish viewing times, send listings to buyers whose searches match, confirm offers, and are billed per branch.
- **The owner's household** (the original single-user tool) still gets the daily Rightmove scrape, the daily email and AI scoring. Other app users' homes are never read from portals on a schedule.

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

## Architecture

| Part | Where | Notes |
|---|---|---|
| Web app | `frontend/` (React + Vite), Vercel | Also wrapped as the iOS app via Capacitor |
| API | `frontend/api/*.js` (12 Vercel functions max), shared code in `frontend/api/_lib/` | Service-role Supabase client, so every route checks the household itself |
| Jobs | `backend/` (Python), GitHub Actions | Scraper and commutes, daily email, viewing reminders, AI scoring, market-data refresh, nightly backup |
| Database | Supabase (Postgres, row-level security, storage) | Migrations in `backend/migrations/` 001–023 |
| Email / push | Resend / APNs | |

**Workflows:** `property-scraper.yml` (daily 07:00 UTC), `daily-property-alerts.yml`, `viewing-reminders.yml` (hourly), `ios-testflight.yml` (manual), `nightly-backup.yml`.

## Open items and things to check
- **Migrations applied?** Confirm 005–023 are applied in Supabase. The commits say 008 was; the rest weren't recorded.
- **Google Routes:** commutes were failing on a 100-a-day quota and on key permissions (403). Check the Routes API is enabled for the key, there's no website-only restriction, and the quota is raised.
- **`ANTHROPIC_API_KEY`** in GitHub secrets, for AI scoring.
- **Vercel:** the live project `property-search-4jcc` needs Root Directory `frontend`, the default build commands, and its environment variables set for Preview as well. The duplicate `property-search` project should be disconnected.
- **Secrets used by the newer features:**
  - APNs: `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`
  - backups: `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE`
  - TestFlight: the App Store Connect API key
  - optional: `AGENT_SIGNUP_CODE`
- **Sign-ups:** these are now deliberately open (households plus email confirmation), which replaces the earlier advice to switch them off.
- **Repo location:** the repo lives in a OneDrive/SharePoint-synced folder. Syncing `.git` this way can corrupt it, so move it out and use GitHub to move work between computers.
- **"Cash rec – refresh" scheduled task:** it creates a new Claude session every 5 minutes and floods the session list. Change it, and archive the old sessions (6 of about 487 done).
