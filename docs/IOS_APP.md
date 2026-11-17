# iPhone app: getting it running on the Mac

The iPhone app is the same React app as the website, wrapped with
[Capacitor](https://capacitorjs.com). The iOS project is already generated in
`frontend/ios/` (Swift Package Manager, so no CocoaPods needed). Everything
below happens on the Mac.

## What's already done (on Windows)

- Capacitor 8 installed; `frontend/capacitor.config.json` sets the app name
  (PropertySearch) and bundle ID (`com.propertysearch.app`).
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

- **Bundle ID is permanent** once uploaded. Change `appId` in
  `frontend/capacitor.config.json` now if you want something else (e.g. your
  own domain reversed, `uk.co.yourdomain.propertysearch`), then
  `npx cap sync ios`. It must match the app you create in App Store Connect.
- **App icon:** needs a 1024×1024 PNG with no transparency. Drop it in
  Xcode under App → Assets → AppIcon.
- **Privacy policy:** set `VITE_CONTACT_EMAIL=...` in Vercel (and
  `frontend/.env`), redeploy, and check `/privacy` reads right. Use the live
  `/privacy` URL in App Store Connect.
- **Supabase → Authentication → URL Configuration:** the live site URL must be
  in Redirect URLs, because password-reset emails sent from the app open the
  website.

## TestFlight (demo on phones without App Store review)

1. In [App Store Connect](https://appstoreconnect.apple.com) → Apps → **+**,
   create the app with the same bundle ID.
2. In Xcode pick **Any iOS Device** as the target, then Product → **Archive**.
3. In the Organizer window that opens: **Distribute App** → App Store Connect
   → Upload.
4. After 10–30 minutes it appears in App Store Connect → TestFlight. Add
   yourself as an internal tester (no review needed) and install the
   **TestFlight** app on your iPhone.
5. For agents and friends: create an external group and share the public
   link (needs a short beta review, usually under a day).

## Still to do (next steps in the plan)

- Push notifications (bookings, price drops, reminders): needs an APNs key
  from the Apple Developer account, `@capacitor/push-notifications`, and a
  device-token table + sender on the server.
- Multi-user sign-up for buyers (currently invite-only, one household).
- Buyer account deletion in-app (agents have it; buyers are invite-only, so
  Apple doesn't require it yet).
