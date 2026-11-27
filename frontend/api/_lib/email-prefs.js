// Who wants which emails, and their private unsubscribe link (migration 028).
// Used by the "new match" email (send-listing.js) and the price-cut email
// (agent-price.js). Push notifications are separate and unaffected.
import { supabaseAdmin } from "./household.js";

export const EMAIL_KINDS = {
  matches: "new homes agents send you",
  price_drops: "price cuts on homes you've saved",
  // Agents' monthly branch report (migration 040, _lib/monthly-report.js).
  monthly_report: "your monthly ViewPal report",
};

// userIds -> Map(userId -> { token, matches, price_drops }). Creates the row
// (everything on) for anyone who hasn't got one yet. Before migration 028 it
// returns everyone as subscribed with no token, so emails still go.
export async function emailPrefs(userIds) {
  const ids = [...new Set(userIds)].filter(Boolean);
  const prefs = new Map(ids.map((id) => [id, { token: null, matches: true, price_drops: true }]));
  if (!ids.length) return prefs;

  const { error: upsertError } = await supabaseAdmin
    .from("email_preferences")
    .upsert(ids.map((id) => ({ user_id: id })), { onConflict: "user_id", ignoreDuplicates: true });
  if (upsertError) return prefs;

  const { data } = await supabaseAdmin
    .from("email_preferences")
    .select("user_id, unsubscribe_token, matches, price_drops")
    .in("user_id", ids);
  for (const row of data || []) {
    prefs.set(row.user_id, { token: row.unsubscribe_token, matches: row.matches, price_drops: row.price_drops });
  }
  return prefs;
}

// The unsubscribe page (a person confirms there) and the one-click address
// mail apps POST to (List-Unsubscribe-Post), for one kind of email.
export function unsubscribeLinks(base, token, kind) {
  if (!token) return null;
  return {
    page: `${base}/unsubscribe?t=${token}&kind=${kind}`,
    oneClick: `${base}/api/buyer-signup?unsubscribe=${token}&kind=${kind}`,
  };
}

// Footer line for the email body.
export function unsubscribeFooter(links, kind) {
  if (!links) return "";
  return `<p style="margin:16px 0 0;font-size:12px;color:#9a9186;">Don't want emails about ${EMAIL_KINDS[kind]}?
  <a href="${links.page}" style="color:#9a9186;">Unsubscribe</a>. You'll still see them in the app.</p>`;
}

// Turn one kind off (or on) for whoever owns this token. -> true if found.
export async function setPreferenceByToken(token, kind, on) {
  if (!EMAIL_KINDS[kind] || !/^[0-9a-f-]{36}$/i.test(String(token || ""))) return false;
  const { data } = await supabaseAdmin
    .from("email_preferences")
    .update({ [kind]: on, updated_at: new Date().toISOString() })
    .eq("unsubscribe_token", token)
    .select("user_id");
  return Boolean(data?.length);
}
