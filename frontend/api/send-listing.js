// Agent sends a listing to every buyer whose saved search it fits.
//   POST /api/send-listing { listingId }
//   POST /api/send-listing { action: "price_update", listingId }
//        the agent changed the price: tell buyers who saved it (_lib/agent-price.js)
//   POST /api/send-listing { action: "for_search", searchId }
//        a buyer saved a search: send them live auto-send listings it fits
//   POST /api/send-listing { action: "status_update", listingId }
//        under offer / sold STC / off market: update buyers' copies (_lib/agent-status.js)
//
// Replaces scraping: instead of us crawling portals, agents push listings
// to buyers who want them (migrations 009 + 010). Each buyer gets a listing
// at most once (listing_sends). Household buyers also get it added to their
// PropertySearch list, where the agent's viewing times show up to book.
// The agent only ever learns how many buyers it reached, never who.
import { requireUser, supabaseAdmin, underRateLimit } from "./_lib/household.js";
import { appBaseUrl } from "./_lib/booking.js";
import { emailLayout, escapeHtml, sendEmail } from "./_lib/email.js";
import { listingKey } from "./_lib/listing.js";
import { agentLabel, detailRow } from "./_lib/viewings.js";
import { sendToUsers } from "./_lib/push.js";
import { withCors } from "./_lib/cors.js";
import { locatePostcode } from "./_lib/geo.js";
import { handlePriceUpdate } from "./_lib/agent-price.js";
import { handleStatusUpdate } from "./_lib/agent-status.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SENDS_PER_DAY = 30;
// Statuses a household gave a property to say "not for us": don't re-add.
const DISMISSED = ["ignored", "archived", "lost"];

export default withCors(handler);

function priceText(price) {
  return price ? `£${Number(price).toLocaleString("en-GB")}` : "";
}

// The household's row for this listing, matched by portal id so different
// URL forms of the same listing count as one.
async function findProperty(listing, householdId) {
  const key = listingKey(listing.listing_url);
  const portalId = key.split(":")[1];
  const { data } = await supabaseAdmin
    .from("properties")
    .select("id, status, listing_url")
    .eq("household_id", householdId)
    .ilike("listing_url", `%${portalId}%`);
  return (data || []).find((p) => listingKey(p.listing_url) === key) || null;
}

async function addToHouseholdList(listing, householdId) {
  const existing = await findProperty(listing, householdId);
  if (existing) return { property: existing, dismissed: DISMISSED.includes(existing.status) };

  const [source, portalId] = listingKey(listing.listing_url).split(":");
  const { data, error } = await supabaseAdmin
    .from("properties")
    .insert({
      household_id: householdId,
      source,
      listing_id: portalId,
      title: listing.address,
      address: listing.address,
      price: listing.price,
      initial_price: listing.price,
      bedrooms: listing.bedrooms,
      image_url: listing.image_url || "",
      listing_url: listing.listing_url,
      postcode: listing.postcode,
      property_type: listing.property_type,
      date_found: new Date().toISOString().split("T")[0],
    })
    .select("id, status")
    .single();

  if (error) {
    console.error("Could not add sent listing to properties:", error);
    return { property: null, dismissed: false };
  }
  return { property: data, dismissed: false };
}

// The booking page for this buyer: their private token fills in their
// details, so booking is pick a time and tap Book (migration 025).
function bookingPath(listing, token) {
  return `/viewings/${listing.id}${token ? `?b=${token}` : ""}`;
}

function listingEmail(listing, agent, base, inList, token) {
  const facts = [
    listing.bedrooms ? `${listing.bedrooms} bed` : "",
    listing.property_type || "",
    listing.has_garden ? "garden" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return emailLayout(
    "A new home that matches your search",
    `${
      listing.image_url
        ? `<img src="${escapeHtml(listing.image_url)}" alt="" style="width:100%;max-width:520px;border-radius:10px;margin-bottom:14px;" />`
        : ""
    }
    <table style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">
      ${detailRow("Property", `<strong>${escapeHtml(listing.address)}</strong>`)}
      ${detailRow("Price", escapeHtml(priceText(listing.price)))}
      ${detailRow("Details", escapeHtml(facts))}
      ${detailRow("Agent", escapeHtml(agentLabel(agent)))}
      ${detailRow("Note", escapeHtml(listing.notes))}
    </table>
    <p style="margin:0 0 16px;">
      <a href="${escapeHtml(base)}${bookingPath(listing, token)}" style="background:#223a33;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">Book a viewing</a>
      &nbsp; <a href="${escapeHtml(listing.listing_url)}" style="color:#223a33;">Full listing</a>
    </p>
    <p style="margin:0;color:#6b7280;font-size:13px;">${
      inList
        ? "It's been added to your PropertySearch list. "
        : ""
    }You're getting this because it fits one of your saved searches. Change them in PropertySearch → Settings.</p>`
  );
}

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (req.body?.action === "for_search") return handleForSearch(req, res);

  const user = await requireUser(req, res);
  if (!user) return;

  const { listingId } = req.body || {};
  if (!UUID_RE.test(String(listingId || ""))) {
    return res.status(400).json({ error: "Missing listing" });
  }

  const { data: listing } = await supabaseAdmin
    .from("agent_listings")
    .select("*, agents(*)")
    .eq("id", listingId)
    .maybeSingle();

  if (!listing || listing.agent_id !== user.id) {
    return res.status(404).json({ error: "Listing not found" });
  }
  // The agent changed the price: pass it on to buyers who saved the home.
  if (req.body?.action === "price_update") return handlePriceUpdate(req, res, listing, user.id);
  // The agent changed the status: pass it on to buyers who saved the home.
  if (req.body?.action === "status_update") return handleStatusUpdate(req, res, listing, user.id);
  if (!listing.is_active) {
    return res.status(409).json({ error: "Show this listing to buyers before sending it." });
  }
  if (listing.market_status === "sold_stc" || listing.market_status === "off_market") {
    return res.status(409).json({ error: "This home is sold or off the market, so it isn't sent to buyers." });
  }
  if (!listing.postcode) {
    return res.status(400).json({ error: "Add the postcode so we can find matching buyers." });
  }

  // Buyers who searched by distance or a drawn area need to know where it is.
  await locatePostcode(listing.postcode);

  const { data: matches, error: matchError } = await supabaseAdmin.rpc("match_buyer_searches", {
    p_postcode: listing.postcode,
    p_price: listing.price,
    p_bedrooms: listing.bedrooms,
    p_property_type: listing.property_type,
    p_has_garden: listing.has_garden,
  });
  if (matchError) {
    console.error("match_buyer_searches failed:", matchError);
    return res.status(500).json({ error: "Could not find matching buyers" });
  }

  const matchedIds = [...new Set((matches || []).map((m) => m.user_id))].filter(
    (id) => id !== user.id
  );
  if (!matchedIds.length) {
    return res.status(200).json({ success: true, matched: 0, sent: 0 });
  }

  if (!(await underRateLimit(user.id, "send_listing", MAX_SENDS_PER_DAY, 24 * 60))) {
    return res.status(429).json({ error: "You've sent a lot of listings today. Try again tomorrow." });
  }

  try {
    const result = await deliverListing(listing, matchedIds, appBaseUrl(req));
    return res.status(200).json({ success: true, matched: matchedIds.length, ...result });
  } catch (error) {
    console.error("listing_sends insert failed:", error);
    return res.status(500).json({ error: "Could not send the listing" });
  }
}

// Send one listing to these buyers: each gets it at most once (listing_sends),
// it's added to their household's list, and they get an email and a push
// with their own one-tap booking link. -> { sent, emailed, pushed }
async function deliverListing(listing, matchedIds, base) {
  // Claim each buyer atomically: only rows actually inserted are emailed, so
  // a double click or two tabs can't send the same listing twice.
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("listing_sends")
    .upsert(
      matchedIds.map((id) => ({ listing_id: listing.id, user_id: id })),
      { onConflict: "listing_id,user_id", ignoreDuplicates: true }
    )
    .select("*");
  if (claimError) throw claimError;

  const newIds = (claimed || []).map((c) => c.user_id);
  // Each buyer's private booking token ("*" above, so this still works
  // before migration 025 adds the column: the link just has no token).
  const tokenOf = new Map((claimed || []).map((c) => [c.user_id, c.book_token || null]));
  if (!newIds.length) return { sent: 0, emailed: 0, pushed: 0 };

  const { data: members } = await supabaseAdmin
    .from("household_members")
    .select("user_id, household_id")
    .in("user_id", newIds);
  const householdOf = new Map((members || []).map((m) => [m.user_id, m.household_id]));

  // Each household shares one property list, so add it once per household.
  const households = new Map();
  for (const householdId of new Set(householdOf.values())) {
    households.set(householdId, await addToHouseholdList(listing, householdId));
  }

  let emailed = 0;
  // They marked this property as not for them: respect that, quietly.
  const recipients = newIds.filter((id) => !households.get(householdOf.get(id))?.dismissed);

  const pushBody = [
    priceText(listing.price),
    listing.bedrooms ? `${listing.bedrooms} bed` : "",
    listing.property_type || "",
    "Tap to book a viewing",
  ]
    .filter(Boolean)
    .join(" · ");
  // One each, so every buyer's tap opens their own pre-filled booking page.
  const push = Promise.all(
    recipients.map((id) =>
      sendToUsers([id], {
        title: `New match: ${listing.address}`,
        body: pushBody,
        url: bookingPath(listing, tokenOf.get(id)),
      }).catch((error) => {
        console.error("Listing push failed:", error);
        return { sent: 0 };
      })
    )
  ).then((results) => ({ sent: results.reduce((n, r) => n + (r?.sent || 0), 0) }));

  await Promise.all(
    recipients.map(async (id) => {
      const inList = Boolean(households.get(householdOf.get(id))?.property);

      const { data } = await supabaseAdmin.auth.admin.getUserById(id);
      const email = data?.user?.email;
      if (!email) return;

      await sendEmail({
        to: email,
        replyTo: listing.agents.email,
        subject: `New match: ${listing.address}${listing.price ? `, ${priceText(listing.price)}` : ""}`,
        html: listingEmail(listing, listing.agents, base, inList, tokenOf.get(id)),
      });
      emailed += 1;
    })
  );

  const { sent: pushed } = await push;
  return { sent: newIds.length, emailed, pushed };
}

// A buyer saved or changed a search: send them every live listing it fits
// that agents have left on auto-send (migration 027), so a new buyer gets
// matching homes straight away rather than waiting for the next listing.
//   POST /api/send-listing { action: "for_search", searchId }   buyer
async function handleForSearch(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const { searchId } = req.body || {};
  if (!UUID_RE.test(String(searchId || ""))) return res.status(400).json({ error: "Missing search" });

  const { data: search } = await supabaseAdmin
    .from("buyer_searches")
    .select("id, user_id")
    .eq("id", searchId)
    .maybeSingle();
  if (!search || search.user_id !== user.id) return res.status(404).json({ error: "Search not found" });

  const { data: rows, error } = await supabaseAdmin.rpc("listings_for_search", { p_search: search.id });
  if (error) {
    // Before migration 027: nothing to send yet, not an error for the buyer.
    console.error("listings_for_search failed:", error);
    return res.status(200).json({ success: true, sent: 0 });
  }

  const ids = (rows || []).map((r) => r.listing_id).slice(0, 20);
  if (!ids.length) return res.status(200).json({ success: true, sent: 0 });
  const { data: listings } = await supabaseAdmin.from("agent_listings").select("*, agents(*)").in("id", ids);

  let sent = 0;
  for (const listing of listings || []) {
    const result = await deliverListing(listing, [user.id], appBaseUrl(req)).catch((err) => {
      console.error("for_search delivery failed:", err);
      return { sent: 0 };
    });
    sent += result.sent;
  }
  return res.status(200).json({ success: true, sent });
}
