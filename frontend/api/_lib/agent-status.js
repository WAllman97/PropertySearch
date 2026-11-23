// An agent changed a listing's status (For sale / Under offer / Sold STC /
// Off market): update every household's saved copy of that home.
//   POST /api/send-listing { action: "status_update", listingId }
// Called by the agent portal after the agent picks a new status
// (migration 024). Buyers who still want the home get a push; homes they've
// written off are kept in step quietly. Idempotent: copies already at the
// new status are left alone.
import { householdMemberIds, supabaseAdmin, underRateLimit } from "./household.js";
import { listingKey } from "./listing.js";
import { sendToUsers } from "./push.js";

// agent_listings.market_status -> properties.listing_status (migration 005).
export const PROPERTY_STATUS = {
  available: "live",
  under_offer: "under_offer",
  sold_stc: "sold_stc",
  off_market: "removed",
};

const PUSH_TEXT = {
  available: "is back on the market",
  under_offer: "is now under offer",
  sold_stc: "is now sold, subject to contract",
  off_market: "has been taken off the market",
};

const DISMISSED = ["ignored", "archived", "lost"];
const MAX_UPDATES_PER_DAY = 60;

export async function handleStatusUpdate(req, res, listing, agentId) {
  if (!(await underRateLimit(agentId, "listing_status_update", MAX_UPDATES_PER_DAY, 24 * 60))) {
    return res.status(429).json({ error: "Too many status changes today. Please try again tomorrow." });
  }
  try {
    const result = await passStatusToBuyers(listing);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("listing status update failed:", error);
    return res.status(500).json({ error: "Could not update buyers' lists" });
  }
}

// Copy the listing's market_status onto every saved copy and push the
// households that still want it. -> { updated, notified }
export async function passStatusToBuyers(listing) {
  const status = PROPERTY_STATUS[listing.market_status];
  const key = listingKey(listing.listing_url);
  const portalId = key?.split(":")[1];
  if (!status || !portalId) return { updated: 0, notified: 0 };

  const { data: candidates } = await supabaseAdmin
    .from("properties")
    .select("id, household_id, address, title, status, listing_status, listing_url")
    .ilike("listing_url", `%${portalId}%`);
  const saved = (candidates || []).filter(
    (p) => listingKey(p.listing_url) === key && p.listing_status !== status
  );
  if (!saved.length) return { updated: 0, notified: 0 };

  const { error } = await supabaseAdmin
    .from("properties")
    .update({ listing_status: status })
    .in("id", saved.map((p) => p.id));
  if (error) throw error;

  // One push per household that still wants the home.
  const households = new Map();
  for (const p of saved) {
    if (!DISMISSED.includes(p.status) && !households.has(p.household_id)) households.set(p.household_id, p);
  }
  await Promise.all(
    [...households.entries()].map(async ([householdId, p]) => {
      const ids = await householdMemberIds(householdId);
      const view = !p.status || p.status === "new" ? "properties" : "history";
      await sendToUsers(ids, {
        title: "Saved home update",
        body: `${p.address || p.title || listing.address} ${PUSH_TEXT[listing.market_status]}`,
        url: `/?view=${view}`,
      });
    })
  );

  return { updated: saved.length, notified: households.size };
}
