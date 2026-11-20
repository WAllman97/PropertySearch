# App Store Connect: what to fill in

Everything App Store Connect asks for, ready to paste. TestFlight needs only
the **Test Information** section; the rest is for the public App Store
release. Check it against the app before submitting: Apple compares the
privacy answers with what the app actually does.

## App information

| Field | Value |
|---|---|
| Name (30 chars max) | PropertySearch. Names are unique across the App Store, so if it's taken try "PropertySearch: Home Buying" or "PropertySearch UK" |
| Subtitle (30) | Home buying, organised |
| Bundle ID | com.wallman97.propertysearch |
| SKU | propertysearch-ios |
| Primary category | Lifestyle |
| Secondary category | Productivity |
| Content rights | Answer **Yes**, it shows third-party content: when a user saves a link, the app shows that page's link preview (title, short summary, main photo), as messaging apps do, and listings agents add themselves. Portal pages are only read when a user pastes a link, never on a schedule. Check this answer with a solicitor before submitting. |
| Age rating | Answer "None" / "No" to every question (gives 4+). "Unrestricted web access": No |
| Privacy policy URL | https://property-search-4jcc.vercel.app/privacy |
| Support URL | https://property-search-4jcc.vercel.app/support |
| Devices | iPhone only (the project is set to iPhone, so no iPad screenshots needed) |

## Test Information (TestFlight)

- **Beta app description:**
  > PropertySearch keeps a home search in one place: save listings from any
  > portal, compare them, keep track of viewings, and book viewings
  > straight from local agents. Partners share one list. Estate agents can
  > publish viewing times and send new listings to matching buyers.
- **Feedback email:** your contact email
- **Sign-in required:** Yes. Use the demo accounts made by
  `frontend/scripts/seed-demo.mjs`: the emails and passwords are in
  `docs/app-review-logins.local.md` (on your PC only, not in git). Put the
  buyer login in the username/password boxes and the agent login in the
  notes. Re-run the script before each submission to refresh the dates.
- **Review notes:**
  > Demo data: the buyer account is a fictional household with saved homes,
  > a booked viewing, an offer and a drawn search area. To see the estate
  > agent side, tap "Estate agent? Sign in or sign up here" on the log-in
  > screen and use the agent login below. Its listings match some of the
  > buyer's homes, so you can book a viewing as the buyer and see it
  > appear for the agent.
  >
  > Agent login: (email) / (password)
  >
  > New accounts confirm their email address before first log-in (the demo
  > accounts are already confirmed). Estate agents need a sign-up code from
  > us, so please use the demo agent rather than signing up. Phone
  > notifications are sent for new matching listings, viewing reminders and
  > price drops. Account deletion: Settings → Delete Account (buyers),
  > bottom of the agent page (agents).

## Description (App Store)

**Promotional text (170):**
> Every home you're considering, in one place, with viewings you can book in
> a tap and new listings sent straight from local agents.

**Description:**
> PropertySearch is a home-buying organiser for you and your partner.
>
> KEEP EVERYTHING TOGETHER
> • Save a home by pasting its link from the property websites you already use
> • Notes, ratings and a shared shortlist for your household
> • Journey times to the places that matter to you
>
> FIND THE RIGHT HOMES
> • Search by postcode, by distance from a place ("within ½ mile of
>   Battersea"), or draw your area on a map
> • Local agents send matching listings straight to you, often before they
>   reach the portals
>
> VIEWINGS WITHOUT THE PHONE TAG
> • Book viewings from agents' available times, with a calendar invite
> • Every viewing in one calendar, shared with your household
> • Reminders the day before
>
> SHOW AGENTS YOU'RE READY
> • Share your buying position (mortgage agreement, chain, solicitor) with
>   agents you book with, so your offers are taken seriously
>
> FOR ESTATE AGENTS
> • Set your viewing hours once: every listing gets bookable times, and a
>   booking at one home takes clashing times off the others
> • Send new listings to buyers whose searches match
> • See each buyer's position, and confirm accepted offers in a tap

**Keywords (100 chars, comma separated, no spaces needed):**
`house,home,buying,property,viewings,book viewing,mortgage,estate agent,flat,shortlist,london,move`

No other companies' names (Rightmove, Zoopla, OnTheMarket) in the name,
subtitle, keywords or description: Apple rejects listings that use other
brands' trademarks to be found. Mentioning them inside the app, where it
helps people use it, is fine.

## Listing data and portals (before submitting)

- Buyers' homes are never re-read from portals on a schedule. Only the
  owner's original household keeps the daily search scrape and price
  checks (backend), as a personal tool.
- Save-a-link reads only the link-preview tags of the one page a buyer
  pastes (`frontend/api/_lib/listing-page.js`).
- Agents on PropertySearch are the licensed source: their details and
  photos are used first.
- Apple guideline 5.2.2 asks that apps showing another service's content
  are allowed to under its terms. Get a short legal view on the link
  previews before launch.

## App Privacy ("nutrition label")

Tracking: **No**, the app doesn't track users. For every data type below:
**linked to the user: Yes**, **used for tracking: No**, purpose **App
Functionality** only.

| Category | Data type | What it is |
|---|---|---|
| Contact Info | Name | Buyer and agent names |
| Contact Info | Email Address | Logins, booking and alert emails |
| Contact Info | Phone Number | Agents' phone; buyer phone on viewing bookings |
| Financial Info | Other Financial Info | Buying position: budget, deposit, mortgage details; optional proof document (mortgage agreement or proof of funds); accepted offer amounts |
| User Content | Other User Content | Saved properties, notes, ratings, searches (incl. drawn areas), commute addresses |
| Identifiers | User ID | Account ID |

Not collected: precise or coarse location (we never read the phone's
location; addresses are typed in), contacts, photos, browsing history,
purchases, health, usage data, diagnostics, advertising data.

## Export compliance

Already answered in the app (`ITSAppUsesNonExemptEncryption = NO` in
Info.plist): the app only uses standard HTTPS, so App Store Connect won't ask
on each build.

## Screenshots (App Store only, not TestFlight)

Ready to upload: `docs/app-store/screenshots/` (nine iPhone 6.9" images,
1320 × 2868, in upload order). Drag them into App Store Connect → your app
→ the version → iPhone 6.9" Display. Apple scales them for smaller iPhones.

They show the demo accounts. Photos are from Unsplash (free for commercial
use, no credit needed); streets are real, listings and prices made up.

To retake them (after a rename or design change):

```
cd frontend
node --env-file=../backend/.env --env-file=.env scripts/seed-demo.mjs
npm install --no-save puppeteer-core@23.11.1
npm run dev        (in another terminal)
node scripts/app-store/shoot.mjs ../docs/app-store/raw
python scripts/app-store/compose.py ../docs/app-store/raw ../docs/app-store/screenshots
```

Captions are in `compose.py`.
