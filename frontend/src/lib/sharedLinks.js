// Links handed to the app from outside:
//   * a property link to open "Add Property" with it already filled in:
//     - the iPhone share sheet: Share → ViewPal opens
//       viewpal://add?url=<listing link> (ios/App/ShareExtension)
//     - the website: /?add=<listing link> (bookmarks, other apps)
//     The link waits here until the Properties view (after log-in) takes it.
//   * a link to our own website that iOS opened in the app (universal
//     links), e.g. "Book a viewing" in an email: shows that page in the app.
import { App as CapApp } from "@capacitor/app";
import { isNativeApp, liveSiteUrl } from "./platform";

// Our website's hosts: links to them open here (universal links). The old
// Vercel address is kept for links in emails sent before the rename.
const siteHosts = new Set([new URL(liveSiteUrl).host, "viewpal.app", "www.viewpal.app", "property-search-4jcc.vercel.app"]);
// viewpal:// from the share extension; propertysearch:// from builds before the rename.
const APP_SCHEMES = new Set(["viewpal:", "propertysearch:"]);

let pending = null;
const listeners = new Set();
let lastLink = "";
let lastAt = 0;

function offer(link) {
  if (typeof link !== "string" || !/^https?:\/\//i.test(link.trim())) return;
  const clean = link.trim();
  // The launch link and the "opened with" event can both report one share.
  if (clean === lastLink && Date.now() - lastAt < 5000) return;
  lastLink = clean;
  lastAt = Date.now();
  pending = clean;
  listeners.forEach((fn) => fn(clean));
}

// A universal link: a link to our own website (e.g. "Book a viewing" in an
// email) that iOS opened in the app instead of Safari. Show the same page
// inside the app. The app's pages are routed by path, like the website.
function openSitePage(parsed) {
  const add = parsed.searchParams.get("add");
  if (add) {
    offer(add);
    return;
  }
  const target = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (target !== here) window.location.assign(target);
}

function fromAppUrl(url) {
  try {
    const parsed = new URL(url);
    if (APP_SCHEMES.has(parsed.protocol) && (parsed.host === "add" || parsed.pathname.replace(/\//g, "") === "add")) {
      offer(parsed.searchParams.get("url"));
    } else if (parsed.protocol === "https:" && siteHosts.has(parsed.host)) {
      openSitePage(parsed);
    }
  } catch {
    // Not a URL we understand: ignore.
  }
}

// The link waiting to be added (and forget it), or null.
export function takeSharedLink() {
  const link = pending;
  pending = null;
  return link;
}

// Called with each new link as it arrives. Returns an unsubscribe function.
export function onSharedLink(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Set up once at launch (main.jsx), so the link that started the app is caught.
export function listenForSharedLinks() {
  const params = new URLSearchParams(window.location.search);
  const add = params.get("add");
  if (add) {
    offer(add);
    params.delete("add");
    const rest = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
  }
  if (!isNativeApp) return;
  CapApp.addListener("appUrlOpen", ({ url }) => fromAppUrl(url));
  CapApp.getLaunchUrl()
    .then((result) => result?.url && fromAppUrl(result.url))
    .catch(() => {});
}
