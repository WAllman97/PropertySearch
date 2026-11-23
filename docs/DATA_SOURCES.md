# Where PropertySearch's data comes from

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
  own listings still fill in from PropertySearch.
- `LINK_PREVIEW_USER_AGENT` sets how the preview identifies itself. By
  default it says who we are (`PropertySearchLinkPreview/1.0 (+…/support)`),
  like any messaging app, rather than posing as a browser.

## The owner's personal tool only (the "original household")

These predate the app, run from GitHub Actions for one household, and are
not offered to anyone else. Each checks `is_original` (migration 013):

| What | Source | Where |
|---|---|---|
| Daily new-listing search | Rightmove, Zoopla and OnTheMarket search pages | `backend/main.py`, `backend/scrapers/` |
| Daily price and status re-check of saved homes | Rightmove listing pages | `backend/core/listing_tracker.py` |
| Bedroom-matched sold prices | Rightmove's sold-price search | `backend/core/rightmove_sold.py`, used only when `compute_comps(..., use_portal=True)` |
| Daily alert email and AI scoring | The above | `backend/jobs/send_daily_property_alerts.py`, `score_properties.py` |

Before PropertySearch is sold to agents, decide whether to switch these off
too, so the company runs no scraper at all. Nothing in the app needs them.

## How the app gets better data without scraping

1. **Agents supply it.** Every agent on PropertySearch keeps their own listings
   current (status, price cuts, auto-send). The more agents, the less any
   buyer depends on a portal link.
2. **CRM feeds, with the agent's permission.** Agents own their listing data
   and already send it to the portals from their CRM (Reapit, Alto, Street,
   etc.). The same feed can come to PropertySearch: the CRM integrations in
   the business plan.
3. **Licensed data if ever needed.** Sold prices with bedrooms are available
   under licence (e.g. from data resellers), if Land Registry by type isn't
   enough.

## Changes made for this (23 Nov 2026)

- Sold-price comparisons for app users switched to Land Registry only; the
  Rightmove sold search is limited to the original household. Comparisons
  already stored stay until their next refresh.
- Link previews stopped posing as Chrome; added the `PORTAL_PREVIEWS`
  off switch.
