# Where ViewPal's data comes from

The rule: **the product never depends on crawling a property portal.**
Agents' homes come from the agents themselves. Portal pages are only read
one at a time, when a person pastes a link, and only their public
link-preview summary, the same thing WhatsApp or iMessage shows. Everything
else is open data or what users type in.

Rightmove's, Zoopla's and OnTheMarket's terms forbid automated scraping, so
this line matters most once agents are paying.

## For everyone using the app

| What | Source | How it's fetched |
|---|---|---|
| Agents' listings: price, beds, type, garden, status, price cuts | **The agent**, in the agent area (paste-to-fill reads their own listing's preview) | Typed or confirmed by the agent; kept up to date by the agent's status and price buttons |
| A home a buyer saves from a portal link | The portal's **link-preview tags** (og:title, og:description, og:image, page title) | One page, when the buyer pastes the link; cached 3 days (12 hours after a failure); max 30 an hour per person; our own agent data used first and the portal not touched at all |
| Sold-price comparisons | **HM Land Registry Price Paid Data** (Open Government Licence) via its SPARQL endpoint, plus postcodes.io | Daily job, by property type (not bedrooms) |
| Postcode locations, distances, commute times | postcodes.io, Google Routes API | APIs |
| Buyer searches, position, status, notes, viewings, offers | The buyer | Typed in |

Controls (Vercel environment variables, no code change needed):

- `PORTAL_PREVIEWS=off` stops every portal fetch immediately. Pasting a link
  still works: the form opens for the buyer or agent to fill in, and agents'
  own listings still fill in from ViewPal.
- `LINK_PREVIEW_USER_AGENT` sets how the preview identifies itself. By
  default it says who we are (`ViewPalLinkPreview/1.0 (+…/support)`),
  like any messaging app, rather than posing as a browser.

## No scrapers

The original single-user tool's scrapers were removed on 23 Nov 2026, before
App Store submission: the daily Rightmove/Zoopla/OnTheMarket search, the
daily re-check of saved Rightmove homes, Rightmove's sold-price search, and
the daily alert email and AI scoring built on them. They're in git history
before that date if ever needed for reference. The company runs no scraper.

## How the app gets better data without scraping

1. **Agents supply it.** Every agent on ViewPal keeps their own listings
   current (status, price cuts, auto-send). The more agents, the less any
   buyer depends on a portal link.
2. **CRM feeds, with the agent's permission.** Agents own their listing data
   and already send it to the portals from their CRM (Reapit, Alto, Street,
   etc.). The same feed can come to ViewPal: the CRM integrations in
   the business plan.
3. **Licensed data if ever needed.** Sold prices with bedrooms are available
   under licence (e.g. from data resellers), if Land Registry by type isn't
   enough.

## Changes made for this (23 Nov 2026)

- Sold-price comparisons switched to Land Registry only, run by their own
  daily job (`.github/workflows/sold-price-comps.yml`). Comparisons already
  stored stay until their next monthly refresh (or run the job by hand with
  "force").
- Link previews stopped posing as Chrome; added the `PORTAL_PREVIEWS`
  off switch.
- The personal scrapers, their daily email and AI scoring removed, with the
  scraper-only "Email Notifications" settings card.
