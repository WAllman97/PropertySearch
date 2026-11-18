// iPhone push notifications, sent straight to Apple (APNs) with token auth.
// No Firebase or other middleman; Node's built-in http2 and crypto only.
// The Python twin (backend/core/push.py) does the same for scheduled jobs.
//
// Server env (Vercel and GitHub secrets):
//   APNS_KEY      contents of the .p8 key from developer.apple.com (Keys)
//   APNS_KEY_ID   that key's 10-character Key ID
//   APNS_TEAM_ID  your 10-character Team ID (Membership details)
//   APNS_BUNDLE_ID  optional, defaults to the app's bundle ID
// Without them, sending is skipped and logged (like email without Resend).
import crypto from "node:crypto";
import http2 from "node:http2";
import { supabaseAdmin } from "./household.js";

const HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || "com.wallman97.propertysearch";

function apnsKey() {
  // Vercel/GitHub often store the PEM with literal "\n"; put real newlines back.
  return (process.env.APNS_KEY || "").replace(/\\n/g, "\n").trim();
}

export function pushConfigured() {
  return Boolean(apnsKey() && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID);
}

const base64url = (input) => Buffer.from(input).toString("base64url");

// Apple wants a fresh provider token at most hourly and no more than every
// 20 minutes, so cache one for 40.
let cachedJwt = { token: null, at: 0 };
export function providerToken(now = Date.now()) {
  if (cachedJwt.token && now - cachedJwt.at < 40 * 60 * 1000) return cachedJwt.token;
  const header = base64url(JSON.stringify({ alg: "ES256", kid: process.env.APNS_KEY_ID }));
  const claims = base64url(
    JSON.stringify({ iss: process.env.APNS_TEAM_ID, iat: Math.floor(now / 1000) })
  );
  const signature = crypto
    .sign("sha256", Buffer.from(`${header}.${claims}`), { key: apnsKey(), dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  cachedJwt = { token: `${header}.${claims}.${signature}`, at: now };
  return cachedJwt.token;
}

function postOne(session, token, body) {
  return new Promise((resolve) => {
    const request = session.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${providerToken()}`,
      "apns-topic": BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });
    let status = 0;
    let data = "";
    request.setTimeout(8000, () => request.close(http2.constants.NGHTTP2_CANCEL));
    request.on("response", (headers) => (status = headers[":status"]));
    request.on("data", (chunk) => (data += chunk));
    request.on("close", () => {
      let reason = "";
      try {
        reason = data ? JSON.parse(data).reason || "" : "";
      } catch {
        reason = data.slice(0, 100);
      }
      resolve({ status, reason });
    });
    request.on("error", (error) => resolve({ status: 0, reason: error.message }));
    request.end(body);
  });
}

function connect(host) {
  const session = http2.connect(host);
  session.on("error", (error) => console.error(`APNs connection error (${host}):`, error.message));
  return session;
}

// Send one notification to a list of device tokens.
// Debug builds from Xcode get sandbox tokens; TestFlight/App Store builds get
// production ones. We can't tell them apart, so try production first and
// fall back to sandbox when Apple says the token isn't one of its own.
// Tokens Apple says are dead get deleted.
export async function sendToTokens(tokens, { title, body, url, data = {} }) {
  if (!tokens.length) return { sent: 0 };
  if (!pushConfigured()) {
    console.log(`[push skipped: APNs not configured] ${tokens.length} phone(s): ${title}`);
    return { sent: 0, skipped: true };
  }

  const payload = JSON.stringify({
    aps: { alert: { title, body }, sound: "default" },
    url: url || "/",
    ...data,
  });

  const sessions = {};
  const session = (env) => (sessions[env] ||= connect(HOSTS[env]));
  const dead = [];
  let sent = 0;

  try {
    await Promise.all(
      tokens.map(async (token) => {
        let result = await postOne(session("production"), token, payload);
        if (result.status === 400 && result.reason === "BadDeviceToken") {
          result = await postOne(session("sandbox"), token, payload);
        }
        if (result.status === 200) sent += 1;
        else if (result.status === 410 || result.reason === "BadDeviceToken" || result.reason === "Unregistered") {
          dead.push(token);
        } else {
          console.error(`APNs refused a push (${result.status} ${result.reason})`);
        }
      })
    );
  } finally {
    Object.values(sessions).forEach((s) => s.close());
  }

  if (dead.length) {
    const { error } = await supabaseAdmin.from("device_tokens").delete().in("token", dead);
    if (error) console.error("Could not remove dead device tokens:", error);
  }
  return { sent };
}

// Every phone registered to these users.
export async function sendToUsers(userIds, message) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return { sent: 0 };
  const { data, error } = await supabaseAdmin.from("device_tokens").select("token").in("user_id", ids);
  if (error) {
    console.error("Could not load device tokens:", error);
    return { sent: 0 };
  }
  return sendToTokens((data || []).map((row) => row.token), message);
}
