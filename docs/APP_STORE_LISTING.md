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
| Content rights | Doesn't contain third-party content you need rights for (listing photos are shown from links agents add) |
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
- **Sign-in required:** Yes. Give a demo buyer login (and, in the notes, a
  demo agent login) that Apple's beta reviewers can use. Create them from the
  live sign-up page with an address you control, add a couple of saved
  properties so the app isn't empty, and don't use your own account.
- **Review notes:**
  > Buyers sign up in the app. Estate agents use the "Estate agent?" link on
  > the login screen. Phone notifications are sent for new matching listings,
  > viewing reminders and booking requests. Account deletion:
  > Settings → Delete Account (buyers), bottom of the agent page (agents).

## Description (App Store)

**Promotional text (170):**
> Every home you're considering, in one place, with viewings you can book in
> a tap and new listings sent straight from local agents.

**Description:**
> PropertySearch is a home-buying organiser for you and your partner.
>
> KEEP EVERYTHING TOGETHER
> • Save a home by pasting its Rightmove, Zoopla or OnTheMarket link
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
> • Book viewings from agents' available times
> • Reminders the day before, all in one calendar
>
> SHOW AGENTS YOU'RE READY
> • Share your buying position (mortgage agreement, chain, solicitor) with
>   agents you book with, so your offers are taken seriously
>
> FOR ESTATE AGENTS
> • Publish viewing times, send new listings to buyers whose searches match,
>   and see proceedable buyers at a glance

**Keywords (100 chars, comma separated, no spaces needed):**
`house,home,buying,property,viewings,rightmove,zoopla,mortgage,estate agent,flat,shortlist,london`

(Check Apple's rules before keeping competitor names like rightmove/zoopla
in keywords. They can get a listing rejected. Safer to drop them.)

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

Needed: iPhone 6.9" (1320 × 2868) or 6.5" (1284 × 2778), 3 to 10 images.
Easiest from a TestFlight build on a large iPhone (side button + volume up),
or from the iOS simulator on the Mac. Suggested set: property list, a
property with notes, the drawn-area search, viewing booking,
calendar, buying position.
