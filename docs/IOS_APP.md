# iPhone app: getting it running on the Mac

The iPhone app is the same React app as the website, wrapped with
[Capacitor](https://capacitorjs.com). The iOS project is already generated in
`frontend/ios/` (Swift Package Manager, so no CocoaPods needed). Everything
below happens on the Mac.

## What's already done (on Windows)

- Capacitor 8 installed; `frontend/capacitor.config.json` sets the app name
  (PropertySearch) and bundle ID (`com.wallman97.propertysearch`, also set in
  the Xcode project).
- App icon and launch screen are in the Xcode asset catalog, made from
  `frontend/resources/icon.svg`. To change them, edit the SVG and run
  `npm run app:icons` (also updates the website's favicon).
- Inside the app, `/api/*` calls and any link we share or email point at the
  live site, `https://property-search-4jcc.vercel.app` (`src/lib/platform.js`).
  Override with `VITE_PUBLIC_SITE_URL` in `frontend/.env` if the domain changes.
- The API accepts requests from the app (`api/_lib/cors.js`). **This must be
  deployed to Vercel before the app can talk to the server.**
- Phone layout: content stays clear of the notch and home bar, fields don't
  zoom when tapped.
- Login screen links to the agent area and privacy policy (there's no address
  bar in the app).
- Agents can delete their account in the app (Apple requirement):
  bottom of the agent page, `POST /api/delete-account`.
- Privacy policy at `/privacy` (needs your contact email, see below).

## One-time setup on the Mac (about an hour)

1. Install **Xcode** from the Mac App Store (large download, ~1 hour). Open it
   once and let it install its extra components, including the iOS simulator.
2. Install **Node.js** LTS from nodejs.org, and **Git** (Xcode installs it;
   run `git --version` in Terminal to check).
3. Get the code and install packages:

   ```bash
   git clone <your GitHub repo URL> rightmove-alerts
   cd rightmove-alerts/frontend
   npm install
   ```

4. Create `frontend/.env` with the same two lines as on Windows
   (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). Copy it across yourself;
   it's not in git.
5. In Xcode → Settings → Accounts, sign in with your Apple ID (the one
   enrolled in the Apple Developer Program).

## Run it on your iPhone

```bash
cd rightmove-alerts/frontend
npm run app:sync   # builds the web app and copies it into the iOS project
npm run app:open   # opens the project in Xcode
```

In Xcode:

1. Click **App** in the left sidebar → **Signing & Capabilities** → tick
   *Automatically manage signing* and pick your **Team**.
2. Plug in your iPhone (or pick a simulator) at the top of the window, and
   press **Run** (▶).
3. First time on a real phone: on the iPhone go to Settings → General →
   VPN & Device Management and trust your developer certificate. Also turn on
   Settings → Privacy & Security → Developer Mode.

After any code change: `npm run app:sync`, then Run again in Xcode.

## Before the first TestFlight upload

- **Bundle ID** `com.wallman97.propertysearch` is permanent once uploaded and
  must match the app you create in App Store Connect.
- **Privacy policy:** set `VITE_CONTACT_EMAIL=...` in Vercel (and
  `frontend/.env`), redeploy, and check `/privacy` reads right. Use the live
  `/privacy` URL in App Store Connect.
- **Supabase → Authentication → URL Configuration:** the live site URL must be
  in Redirect URLs, because password-reset emails sent from the app open the
  website.

## TestFlight (demo on phones without App Store review)

1. In [App Store Connect](https://appstoreconnect.apple.com) → Apps → **+**,
   create the app with bundle ID `com.wallman97.propertysearch`. If it isn't
   in the list, register it first at developer.apple.com → Certificates,
   Identifiers & Profiles → Identifiers (Xcode usually does this for you the
   first time you run on your phone).
2. In Xcode pick **Any iOS Device** as the target, then Product → **Archive**.
3. In the Organizer window that opens: **Distribute App** → App Store Connect
   → Upload.
4. After 10–30 minutes it appears in App Store Connect → TestFlight. Add
   yourself as an internal tester (no review needed) and install the
   **TestFlight** app on your iPhone.
5. For agents and friends: create an external group and share the public
   link (needs a short beta review, usually under a day).

## Push notifications

What's built: the app asks once after login (and has an on/off switch in
Settings → Phone Notifications), stores the phone's token in `device_tokens`
(migration 012), and forgets it on log-out. Notifications sent:

- **New match** when an agent sends a listing (`api/send-listing.js`); tapping
  opens the viewing times page.
- **Viewing reminder** the day before (`backend/jobs/send_viewing_reminders.py`);
  tapping opens the Calendar.
- **Price drop** after the 07:00 scraper run, for cuts it saw that morning
  (`backend/core/price_drops.py`, called from `main.py`). One per property,
  or a single summary if there are more than three. Ignored, archived and
  lost properties are left out.
- **Booking request** when an agent asks for a call or viewing through your
  booking page (`api/booking.js`); tapping opens the Calendar to accept or
  decline.

Senders: `frontend/api/_lib/push.js` (Vercel) and `backend/core/push.py`
(GitHub Actions). They talk to Apple directly (no Firebase). Until the key
below is set they skip sending and log `[push skipped: APNs not configured]`.

One-time setup once the developer account is approved:

1. developer.apple.com → Certificates, Identifiers & Profiles → **Keys** → **+**.
   Name it e.g. "PropertySearch push", tick **Apple Push Notifications service
   (APNs)**, Continue → Register → **Download**. The `.p8` file downloads only
   once: keep a copy somewhere safe (password manager or cloud drive).
2. Note the **Key ID** (10 characters, on the key page) and your **Team ID**
   (top right of the developer site, or Membership details).
3. Add three settings in **Vercel** (Project → Settings → Environment
   Variables) and in **GitHub** (repo → Settings → Secrets and variables →
   Actions):
   - `APNS_KEY`: the whole contents of the `.p8` file, including the
     `-----BEGIN PRIVATE KEY-----` lines
   - `APNS_KEY_ID`
   - `APNS_TEAM_ID`

   Redeploy on Vercel afterwards.
4. In Xcode → App → Signing & Capabilities, check **Push Notifications** is
   listed (the entitlement is already in `App/App.entitlements`; if it's
   missing, click **+ Capability** → Push Notifications).
5. Run on your iPhone (push doesn't work in the simulator), tap **Turn on**,
   then send yourself a listing from the agent page to test.

The same key works for Xcode builds and TestFlight/App Store builds: the
server tries Apple's live server first and falls back to the test one.

## Buyer accounts

Anyone can sign up from the login screen (`api/buyer-signup.js`). Each new
buyer gets their own household (migrations 013, 014) with a separate property
list, calendar, notes and commute addresses. Settings → Household has an
invite link (`/join/<code>`) that lets a partner join instead (up to 4
people), and Settings → Delete Account removes the login, plus the household
and its data when the last person leaves (Apple requirement). In the app the
invite link points at the live site, where the partner signs up, then logs
in on their phone.

New households get the app only: the scraper, its daily email, AI scoring
and price-drop alerts stay with the original household.

## Still to do (next steps in the plan)

- Nothing blocking TestFlight in the code; see the setup steps above.
