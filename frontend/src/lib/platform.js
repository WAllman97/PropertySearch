import { Capacitor } from "@capacitor/core";

// Inside the iPhone/Android app the page is served from the phone itself
// (capacitor://localhost), so /api/* and any link we share or email must
// point at the live website instead. In a browser, keep using the current
// origin so local dev and preview deployments still talk to themselves.
export const isNativeApp = Capacitor.isNativePlatform();

const LIVE_SITE_URL = (
  import.meta.env.VITE_PUBLIC_SITE_URL || "https://property-search-4jcc.vercel.app"
).replace(/\/$/, "");

// Base for links people open outside the app (share links, email redirects).
export const siteUrl = isNativeApp ? LIVE_SITE_URL : window.location.origin;

// "/api/viewings" -> full URL when running in the app.
export function apiUrl(path) {
  return isNativeApp ? `${LIVE_SITE_URL}${path}` : path;
}
