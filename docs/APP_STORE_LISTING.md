# App Store Connect: what to fill in

Everything App Store Connect asks for, ready to paste. TestFlight needs only
the **Test Information** section; the rest is for the public App Store
release. Check it against the app before submitting: Apple compares the
privacy answers with what the app actually does.

## App information

| Field | Value |
|---|---|
| Name (30 chars max) | ViewPal. Names are unique across the App Store, so if it's taken try "ViewPal: Home Buying" or "ViewPal UK" |
| Subtitle (30) | Home buying, organised |
| Bundle ID | com.wallman97.propertysearch |
| SKU | viewpal-ios |
| Primary category | Lifestyle |
| Secondary category | Productivity |
| Content rights | Answer **Yes**, it shows third-party content: when a user saves a link, the app shows that page's link preview (title, short summary, main photo), as messaging apps do, and listings agents add themselves. Portal pages are only read when a user pastes a link, never on a schedule. Check this answer with a solicitor before submitting. |
| Age rating | Answer "None" / "No" to every question (gives 4+). "Unrestricted web access": No |
| Privacy policy URL | https://viewpal.app/privacy |
| Support URL | https://viewpal.app/support |
| Devices | iPhone only (the project is set to iPhone, so no iPad screenshots needed) |

## Test Information (TestFlight)

- **Beta app description:**
  > ViewPal keeps a home search in one place: save listings from any
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
  > To sign in: the app opens on "Create an account" on a new phone; tap
  > "Already have an account? Log in" at the bottom.
  >
  > Demo data: the buyer account is a fictional household with saved homes,
  > a booked viewing, an offer and a drawn search area. To see the estate
  > agent side, tap "Estate agent? Sign in or sign up here" on the log-in
  > screen and use the agent login below. Its listings match some of the
  > buyer's homes, so you can book a viewing as the buyer and see it
  > appear for the agent.
  >
  > Agent login: (email) / (password)
  >
  > Things to try as the buyer: Settings → "Where you are" pauses the search
  > or marks "Found somewhere", which every agent the buyer deals with sees
  > at once; Settings → Agents chooses what each agent can see and send.
  > As the agent: the card at the top shows the time the app has saved.
  >
  > Built for iPhone, not just a website: phone notifications (new matching
  > homes, viewing reminders, bookings, agents' price cuts and offer
  > answers); a Share-sheet extension to save a home from Safari or any
  > property app; links in our emails open straight in the app (universal
  > links); viewings go into the iPhone Calendar from the share sheet; and
  > a phone-first calendar and layout.
  >
  > New accounts confirm their email address before first log-in (the demo
  > accounts are already confirmed). Estate agents need a sign-up code from
  > us, so please use the demo agent rather than signing up. Account
  > deletion: Settings → Delete Account (buyers), bottom of the agent page
  > (agents).
  >
  > Listing details: agents enter their own listings. When a buyer pastes a
  > link to a home on another website, the app shows only that page's
  > public link preview (title, summary, photo), the same as Messages or
  > WhatsApp. Nothing is collected from other websites automatically.

## Description (App Store)

**Promotional text (170):**
> Every home you're considering, in one place, with viewings you can book in
> a tap and new listings sent straight from local agents.

**Description:**
> ViewPal is a home-buying organiser for you and your partner.
>
> KEEP EVERYTHING TOGETHER
> • Save a home by pasting its link from the property websites you already use
> • Notes, ratings and a shared shortlist for your household
> • Journey times to the places that matter to you
> • Your must-haves list: tick each one off at a viewing, and see at a
>   glance which homes fall short
>
> FIND THE RIGHT HOMES
> • Search by postcode, by distance from a place ("within ½ mile of
>   Battersea"), or draw your area on a map
> • Local agents send matching listings straight to you, often before they
>   reach the portals
>
> VIEWINGS WITHOUT THE PHONE TAG
> • Book a viewing in one tap, straight from an agent's email: your details
>   are already filled in
> • Every viewing in one calendar, shared with your household, and added
>   to your iPhone calendar
> • Reminders the day before
>
> ONE UPDATE, EVERY AGENT
> • Found somewhere, or taking a break? Tell every agent at once, and the
>   calls and emails stop
> • Choose what each agent can see, and which ones can send you homes
> • Share your buying position (mortgage agreement, chain, solicitor) with
>   agents you deal with, so your offers are taken seriously
> • Hear straight away when an agent cuts the price of a home you saved
>
> FOR ESTATE AGENTS
> • Paste your listing's link and the details fill themselves in
> • Set your viewing hours once: every listing gets bookable times, and a
>   booking at one home takes clashing times off the others
> • New listings go to buyers whose searches match, automatically
> • See each buyer's position and status, confirm accepted offers in a tap,
>   and see how much time the app has saved you

**Keywords (100 chars, comma separated, no spaces needed):**
`house,home,buying,property,viewings,book viewing,mortgage,estate agent,flat,shortlist,london,move`

No other companies' names (Rightmove, Zoopla, OnTheMarket) in the name,
subtitle, keywords or description: Apple rejects listings that use other
brands' trademarks to be found. Mentioning them inside the app, where it
helps people use it, is fine.

## Listing data and portals (before submitting)

- Nothing reads a portal on a schedule: the personal search scrape and
  price checks were removed on 23 Nov 2026 (docs/DATA_SOURCES.md). Sold
  prices come from HM Land Registry open data.
- Save-a-link reads only the link-preview tags of the one page a buyer
  pastes (`frontend/api/_lib/listing-page.js`).
- Agents on ViewPal are the licensed source: their details and
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
| Contact Info | Name | Buyer and agent names (agents also give their agency and branch) |
| Contact Info | Email Address | Logins, booking and alert emails |
| Contact Info | Phone Number | Agents' phone; buyer phone on viewing bookings; the number an agent gives for their setup call |
| Financial Info | Other Financial Info | Buying position: budget, deposit, mortgage details; optional proof document (mortgage agreement or proof of funds); accepted offer amounts; the buyer's cost estimates (stamp duty, fees) |
| User Content | Photos or Videos | Photos a buyer adds to a viewing (from the camera or photo library), and a photo of a proof document if they upload one as an image |
| User Content | Other User Content | Saved properties, notes, ratings, must-haves, viewing feedback, searches (incl. drawn areas), commute addresses; agents' listings and the note on a setup call |
| Identifiers | User ID | Account ID |

Not collected: precise or coarse location (we never read the phone's
location; addresses are typed in and areas drawn on a map), contacts,
browsing history, purchases, health, search history, usage data,
diagnostics, advertising data. There are no analytics or crash-reporting
tools in the app (checked 26 Nov 2026). Push notification tokens are
stored to send notifications; Apple doesn't treat these as a "Device ID",
so they aren't declared.

Check this list again whenever a feature adds a new kind of data (for
example, payment details once agent billing goes live: Stripe takes card
details on its own page, but billing names and addresses would count).

## Export compliance

Already answered in the app (`ITSAppUsesNonExemptEncryption = NO` in
Info.plist): the app only uses standard HTTPS, so App Store Connect won't ask
on each build.

## Screenshots (App Store only, not TestFlight)

Ready to upload: `docs/app-store/screenshots/` (ten iPhone 6.9" images,
1320 × 2868, in upload order; retaken 26 Nov 2026 with the ViewPal name). Drag them into App Store Connect → your app
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

If `shoot.mjs` fails with `Error: UNKNOWN: unknown error, read`, OneDrive is
getting in the way of Node reading files in the synced folder. Copy
`shoot.mjs` to a folder outside OneDrive, run `npm install
puppeteer-core@23.11.1` there, and run it from `frontend` as
`node <that folder>\shoot.mjs ../docs/app-store/raw`. Set `SHOOT_BASE` if
the dev server isn't on port 5173.
