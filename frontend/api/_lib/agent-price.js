// An agent changed a listing's price: pass it on to every household that
// saved that home. Agents on PropertySearch are the licensed source for
// price changes (portals aren't read on a schedule for app users).
//   POST /api/send-listing { action: "price_update", listingId }
// Called by the agent portal after the agent saves a new price.
//
// For each saved copy at a different price: a price_history row (source
// "agent"), the new asking price, and for a cut the "Reduced" date. Each
// household with a cut gets a push and an email. Idempotent: homes already
// at the agent's price are left alone, so calling it twice changes nothing.
import { householdMemberIds, supabaseAdmin, underRateLimit } from "./household.js";
import { appBaseUrl } from "./booking.js";
import { emailLayout, escapeHtml, sendEmail } from "./email.js";
import { listingKey } from "./listing.js";
import { agentLabel, detailRow } from "./viewings.js";
import { sendToUsers } from "./push.js";

// Homes the household has written off: keep them in step, but no alert.
const DISMISSED = ["ignored", "archived", "lost"];
const MAX_UPDATES_PER_DAY = 40;

const pounds = (n) => `£${Number(n).toLocaleString("en-GB")}`;

async function memberEmails(ids) {
  const users = await Promise.all(ids.map((id) => supabaseAdmin.auth.admin.getUserById(id)));
  return users.map((u) => u.data?.user?.email).filter(Boolean);
}

export async function handlePriceUpdate(req, res, listing, agentId) {
  const price = Number(listing.price);
  if (!Number.isInteger(price) || price <= 0) return res.status(200).json({ success: true, updated: 0, notified: 0 });
  if (!(await underRateLimit(agentId, "listing_price_update", MAX_UPDATES_PER_DAY, 24 * 60))) {
    return res.status(429).json({ error: "Too many price changes today. Please try again tomorrow." });
  }

  const key = listingKey(listing.listing_url);
  const portalId = key?.split(":")[1];
  if (!portalId) return res.status(200).json({ success: true, updated: 0, notified: 0 });

  const { data: candidates } = await supabaseAdmin
    .from("properties")
    .select("id, household_id, address, title, price, initial_price, status, image_url, listing_url")
    .ilike("listing_url", `%${portalId}%`);
  const saved = (candidates || []).filter((p) => listingKey(p.listing_url) === key && p.price !== price);

  const now = new Date().toISOString();
  const cutsByHousehold = new Map();
  for (const property of saved) {
    const old = property.price;
    await supabaseAdmin.from("price_history").insert({ property_id: property.id, price, source: "agent" });
    const update = { price, last_price_change_at: now, initial_price: property.initial_price ?? old ?? price };
    const isCut = Number.isInteger(old) && price < old;
    if (isCut) update.price_reduced_at = now;
    await supabaseAdmin.from("properties").update(update).eq("id", property.id);
    if (isCut && listing.is_active && !DISMISSED.includes(property.status)) {
      if (!cutsByHousehold.has(property.household_id)) cutsByHousehold.set(property.household_id, []);
      cutsByHousehold.get(property.household_id).push({ ...property, old });
    }
  }

  const base = appBaseUrl(req);
  const agent = listing.agents ? agentLabel(listing.agents) : "";
  await Promise.all(
    [...cutsByHousehold.entries()].map(async ([householdId, cuts]) => {
      const ids = await householdMemberIds(householdId);
      const emails = await memberEmails(ids);
      const cut = cuts[0];
      // Homes still "new" are on the Properties tab; the rest on the Watchlist.
      const view = !cut.status || cut.status === "new" ? "properties" : "history";
      const place = cut.address || cut.title || listing.address;
      const drop = cut.old - price;
      const pct = Math.round((drop / cut.old) * 1000) / 10;
      await Promise.all([
        sendToUsers(ids, {
          title: "Price reduced",
          body: `${place}: now ${pounds(price)} (down ${pounds(drop)})`,
          url: `/?view=${view}`,
        }),
        ...emails.map((to) =>
          sendEmail({
            to,
            replyTo: listing.agents?.email,
            subject: `Price reduced: ${place}, now ${pounds(price)}`,
            html: emailLayout(
              "A home you saved is now cheaper",
              `${cut.image_url ? `<img src="${escapeHtml(cut.image_url)}" alt="" style="width:100%;max-height:240px;object-fit:cover;border-radius:10px;margin-bottom:12px;">` : ""}
              <table style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">
                ${detailRow("Home", escapeHtml(place))}
                ${detailRow("Now", `<strong>${escapeHtml(pounds(price))}</strong>`)}
                ${detailRow("Was", `<s>${escapeHtml(pounds(cut.old))}</s> (down ${escapeHtml(pounds(drop))}, ${pct}%)`)}
                ${detailRow("Agent", escapeHtml(agent))}
              </table>
              <p style="margin:0;"><a href="${escapeHtml(base)}/?view=${view}" style="color:#223a33;font-weight:bold;">Open it in PropertySearch</a>.
              The agent's viewing times are there if you'd like another look. Reply to this email to reach the agent.</p>`
            ),
          })
        ),
      ]);
    })
  );

  return res.status(200).json({ success: true, updated: saved.length, notified: cutsByHousehold.size });
}
