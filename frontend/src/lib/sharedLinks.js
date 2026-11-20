// A property link handed to the app from outside, to open "Add Property"
// with it already filled in:
//   * the iPhone share sheet: Share → PropertySearch opens
//     propertysearch://add?url=<listing link> (ios/App/ShareExtension)
//   * the website: /?add=<listing link> (bookmarks, other apps)
// The link waits here until the Properties view (after log-in) takes it.
import { App as CapApp } from "@capacitor/app";
import { isNativeApp } from "./platform";

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

function fromAppUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "propertysearch:" && (parsed.host === "add" || parsed.pathname.replace(/\//g, "") === "add")) {
      offer(parsed.searchParams.get("url"));
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
