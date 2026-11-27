# Agent value features (brief of 26 Nov 2026)

Three features to make the £149 + VAT per branch per month price easy to
justify:

| # | Feature | Status |
|---|---|---|
| 3 | Monthly "what ViewPal did for you" email and portal card | **Built 27 Nov** (migration 040; needs `CRON_SECRET`) |
| 1 | Valuation leads | Design below. **Hold the build until the agent meeting on 4 Dec** |
| 2 | Viewing feedback for the vendor | Mostly already built in migration 035. Design for the rest is below. **Hold the build until 4 Dec** |

Out of scope: CRM integrations, AI search, mortgage tools. Pricing and
annual billing are a separate Stripe task.

## 3. Monthly report (built)

- **Figures.** `branch_report(branch, from, to)` in migration 040 gives one
  branch's figures:
  - viewings booked
  - different buyers
  - buyers with proof of funds, cash or an agreement in principle (only
    households that share their position)
  - viewings held
  - cancellations with notice
  - feedback answers
  - homes sent
  - accepted offers
  - time saved, using the same estimates as the time-saved card
  - an `active` flag

  No-shows aren't recorded anywhere, so they are left out.
- **Email.** It goes to every agent at the branch with an email address. Each
  agent can unsubscribe with one click (`email_preferences.monthly_report`).
- **Sending.**
  - GitHub workflow `monthly-value-report.yml` runs at 8am UTC on the 1st,
    and again on the 2nd and 3rd to catch up.
  - It calls `/api/agent-signup` with action `monthly_report_run` and the
    `CRON_SECRET` header. Each call works for about 7 seconds, and the
    workflow repeats until no branches are left.
  - Each branch is claimed in `branch_monthly_reports` before sending, so no
    branch is emailed twice.
  - Branches with nothing that month get a `no_activity` row instead of an
    email.
  - Cancelled branches, and trial agents whose trial ended before the month,
    are skipped.
- **Agent portal.** On the Today tab, "What ViewPal did for you" shows this
  month so far or last month, with the same wording as the email
  (`api/_lib/report-rows.js`). It replaces the older time-saved and branch
  cards, which come back if migration 040 hasn't been run.
- **/admin → Monthly reports.**
  - Pick a month to see who was emailed.
  - Branches with no activity are marked "Churn risk".
  - Preview any branch's email and use "Send test to me".
- **Setup (one-off).**
  1. Run `backend/migrations/040_monthly_value_report.sql` in Supabase.
  2. Make a long random value. For example, in PowerShell:
     `[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")`
  3. Add that value as `CRON_SECRET` in two places:
     - Vercel: project → Settings → Environment Variables. Then redeploy.
     - GitHub: repo → Settings → Secrets → Actions.
  4. Optional: add an `APP_URL` repo variable if the site isn't
     https://viewpal.app.
  5. To try it, run the workflow by hand (Actions → Monthly Value Report →
     Run workflow) with a month.

## 1. Valuation leads (design only)

**Trigger.** The buyer's position has `selling_status = 'not_listed'` ("Need
to sell, not listed yet", migration 015).

**Where we ask.** Once per agent, with Yes / Not now, and no by default:

- after booking a viewing with that agent
- on the buying-position screen, for agents they deal with (`my_agents()`)

The question: "Would you like a free valuation from {agency}?"

**Proposed migration (041):**

```sql
create table valuation_leads (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  agent_id uuid not null references agents (user_id) on delete cascade,
  -- Copied at consent so the branch keeps the lead if the agent leaves:
  -- a sign-up code, or 'agent:<id>' (the branch_billing keys).
  branch_key text not null,
  -- 'yes' shares the lead; 'not_now' is remembered so we don't ask again.
  answer text not null check (answer in ('yes', 'not_now')),
  -- What the buyer saw and when (UK GDPR record of consent).
  consent_text text not null,
  consented_by uuid references auth.users (id) on delete set null,
  consented_at timestamptz not null default now(),
  withdrawn_at timestamptz,   -- set from Settings: hides the lead from the agent
  -- Snapshot of what is shared (the buyer can see it before saying yes).
  contact_name text, contact_email text, contact_phone text,
  sell_area text,             -- postcode district or area of the home to sell
  property_type text, bedrooms integer, timeframe text,
  -- Kept by the agent.
  status text not null default 'new'
    check (status in ('new', 'contacted', 'booked', 'instructed', 'lost')),
  status_changed_at timestamptz,
  -- For counting (and pricing later): where the lead came from.
  source text not null check (source in ('booking', 'position_screen')),
  unique (household_id, agent_id)
);
```

- **Buyer.** Reads and withdraws their own leads through a household policy.
  An `answer_valuation(agent, answer, source)` RPC records the consent text on
  the server, so the client can't change the wording.
- **Agent.** Uses an `agent_valuation_leads()` RPC that returns `answer =
  'yes'` and `withdrawn_at is null` rows for the agent's branch. A
  `set_valuation_status(id, status)` RPC updates the status.
- **Email.** The branch gets an email when a new lead arrives. It can go from
  the existing booking route, so no new Vercel function is needed.
- **Admin and reporting.**
  - /admin shows a count of leads by branch.
  - The monthly report gets a `valuation_leads` row. `branch_report` gains one
    count.
- **Privacy policy.** Add a line: "If you ask for a valuation, we share your
  name, contact details and the area of the home you're selling with that
  agent. You can withdraw this in Settings."

**Questions for 4 Dec:**

- Branch-wide or the one agent?
- What is the sell area: postcode district, or full address?
- Is asking after booking too pushy?

## 2. Viewing feedback (most of it exists)

**Already live (migration 035):**

- About 2 hours after a viewing, the hourly job asks the buyer once by push
  and email. The app also shows a card.
- The buyer answers Not for us / Maybe / Second look, with an optional note
  of up to 140 characters. This is separate from their private notes.
- Agents see the answers on the booking sheet and under "How viewings went".
- Each listing has a private seller report link (`/report/<token>`) with
  anonymised feedback, counts, offers and the price history.

**Gaps against the brief, and the proposed changes (042):**

1. **Interest scale.** The brief has 4 levels: Not for us / Maybe / Very
   interested / Likely to offer. Today there are 3.
   - Proposal: allow `very_interested` and `likely_to_offer` in the check
     constraint.
   - Map the old `second_look` to `very_interested` when displaying.
   - Keep one-tap answers in the email: the first tap saves the interest, and
     the price question follows in the app.
2. **View on price.**
   `alter table viewing_feedback add column price_view text check (price_view in ('below', 'about_right', 'above'))`.
   `save_viewing_feedback` gains a `p_price_view` argument; the old 4-argument
   version is kept for older app builds.
3. **One reminder after 24 hours.** Add `viewing_bookings.feedback_reminded_at`.
   The hourly job sends one reminder 24 hours after the first ask if there is
   no answer, then stops.
4. **Per-property summary for the vendor.**
   - The data already exists: the seller report.
   - Add "Copy for vendor", a plain-text summary: counts by interest and by
     price view, plus the comments.
   - Add "Email to vendor": the agent types the address, and it's sent once
     and not stored. This can be an action on `/api/send-listing.js`, so no
     new function is needed.
   - Optional: `agent_listings.vendor_email` if agents want it remembered.

**Question for 4 Dec:** do agents want the vendor email sent from ViewPal,
or just the copy button and the existing link?
