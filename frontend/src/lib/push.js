// Phone notifications in the iPhone app (APNs via @capacitor/push-notifications).
// On the website every function here is a no-op that reports "unsupported".
//
// "On" is remembered per phone (localStorage), so whoever signs in on this
// phone keeps getting notifications until they switch them off. The token is
// stored against the signed-in account via register_device_token
// (migration 012) and removed on sign-out, so a shared phone never receives
// someone else's alerts.
import { PushNotifications } from "@capacitor/push-notifications";
import { isNativeApp, liveSiteUrl } from "./platform";
import { supabase } from "./supabaseClient";

const ENABLED_KEY = "push_enabled";
const TOKEN_KEY = "push_token";
const PROMPTED_KEY = "push_prompted";

function readStore(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode etc.: the preference just won't stick.
  }
}

// Ask iOS for this phone's token. Resolves with the hex token string.
function registerForToken() {
  return new Promise((resolve, reject) => {
    const handles = [];
    const finish = (fn, value) => {
      clearTimeout(timer);
      handles.forEach((h) => h.then((handle) => handle.remove()));
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("No response from Apple. Try again.")), 15000);
    handles.push(PushNotifications.addListener("registration", (token) => finish(resolve, token.value)));
    handles.push(
      PushNotifications.addListener("registrationError", (error) =>
        finish(reject, new Error(error?.error || "Could not register for notifications"))
      )
    );
    PushNotifications.register().catch((error) => finish(reject, error));
  });
}

async function saveToken(token) {
  const { error } = await supabase.rpc("register_device_token", { p_token: token });
  if (error) throw new Error(error.message);
  writeStore(TOKEN_KEY, token);
}

// "unsupported" | "denied" | "on" | "off"
export async function pushStatus() {
  if (!isNativeApp) return "unsupported";
  const { receive } = await PushNotifications.checkPermissions();
  if (receive === "denied") return "denied";
  return receive === "granted" && readStore(ENABLED_KEY) === "1" ? "on" : "off";
}

// Ask permission (first time shows Apple's prompt), then register this phone.
export async function enablePush() {
  if (!isNativeApp) return "unsupported";
  writeStore(PROMPTED_KEY, "1");
  let { receive } = await PushNotifications.checkPermissions();
  if (receive !== "granted") ({ receive } = await PushNotifications.requestPermissions());
  if (receive !== "granted") return "denied";
  await saveToken(await registerForToken());
  writeStore(ENABLED_KEY, "1");
  return "on";
}

export async function disablePush() {
  writeStore(ENABLED_KEY, null);
  await forgetThisPhone();
  return "off";
}

// Called before sign-out: stop this account's alerts reaching this phone.
// Keeps the phone's on/off preference for whoever signs in next.
export async function forgetThisPhone() {
  const token = readStore(TOKEN_KEY);
  if (!isNativeApp || !token) return;
  try {
    await supabase.rpc("unregister_device_token", { p_token: token });
  } catch (error) {
    console.error("Could not remove this phone's notification token:", error);
  }
  writeStore(TOKEN_KEY, null);
}

// After sign-in: tokens can change (reinstall, restore), so re-register
// quietly whenever notifications are on. Never shows a prompt.
export async function refreshPushRegistration() {
  if ((await pushStatus()) !== "on") return;
  try {
    await saveToken(await registerForToken());
  } catch (error) {
    console.error("Could not refresh notification registration:", error);
  }
}

// Show the one-time "turn on notifications" banner?
export async function shouldOfferPush() {
  if (!isNativeApp || readStore(PROMPTED_KEY) === "1") return false;
  return (await pushStatus()) === "off";
}

export function dismissPushOffer() {
  writeStore(PROMPTED_KEY, "1");
}

// Tapping a notification opens the page it's about. Set up once at launch so
// a tap that starts the app is caught too.
export function listenForNotificationTaps() {
  if (!isNativeApp) return;
  PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
    let url = action?.notification?.data?.url;
    // A full link to our own website counts too: keep just the path.
    if (typeof url === "string" && url.startsWith(`${liveSiteUrl}/`)) url = url.slice(liveSiteUrl.length);
    // Only our own pages: a path, never another site.
    if (typeof url === "string" && url.startsWith("/") && !url.startsWith("//")) {
      window.location.assign(url);
    }
  });
}
