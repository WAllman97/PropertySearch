// Agent sends a listing to every buyer whose saved search it fits.
//   POST /api/send-listing { listingId }
//   POST /api/send-listing { action: "price_update", listingId }
//        the agent changed the price: tell buyers who saved it (_lib/agent-price.js)
//   POST /api/send-listing { action: "for_search", searchId }
//        a buyer saved a search: send them live auto-send listings it fits
//   POST /api/send-listing { action: "status_update", listingId }
//        under offer / sold STC / off market: update buyers' copies (_lib/agent-status.js)
//   GET  /api/send-listing?report=<report_token>
//        the seller report the agent shares with the vendor (no login; the
//        private link is the key, migration 035). Counts, dates, anonymised
//        feedback, offers and prices only: never buyers' names or contacts.
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
import { emailPrefs, unsubscribeFooter, unsubscribeLinks } from "./_lib/email-prefs.js";

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

function listingEmail(listing, agent, base, inList, token, unsubscribe) {
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
    }You're getting this because it fits one of your saved searches. Change them in PropertySearch → Settings.</p>
    ${unsubscribeFooter(unsubscribe, "matches")}`
  );
}

async function handler(req, res) {
  if (req.method === "GET" && req.query?.report) return handleSellerReport(req, res);
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
  // The agent changed the status: pass it on to buyers who saved the home.
  // Not behind the trial check below: Sold STC / Off market must still reach
  // buyers after a trial ends, so they don't chase a home that's gone.
  if (req.body?.action === "status_update") return handleStatusUpdate(req, res, listing, user.id);
  // A free trial that has ended (migration 034): no new buyer contact until
  // the agent adds a branch code (price cuts included). Their existing
  // viewings still go ahead.
  const agentRow = listing.agents || {};
  const trialOver = agentRow.trial_ends_at && !agentRow.signup_code && new Date(agentRow.trial_ends_at) < new Date();
  // The agent changed the price: pass it on to buyers who saved the home.
  if (req.body?.action === "price_update") {
    if (trialOver) {
      return res.status(403).json({ error: "Your free trial has ended. Add your branch code in Settings to tell buyers about price changes." });
    }
    return handlePriceUpdate(req, res, listing, user.id);
  }
  // A new seller report link: the old one (forwarded, or after the sale)
  // stops working straight away.
  if (req.body?.action === "new_report_link") {
    const { data: renewed, error: renewError } = await supabaseAdmin
      .from("agent_listings")
      .update({ report_token: crypto.randomUUID() })
      .eq("id", listing.id)
      .select("report_token")
      .single();
    if (renewError) {
      console.error("new report link failed:", renewError);
      return res.status(500).json({ error: "Could not make a new link. Please try again." });
    }
    return res.status(200).json({ success: true, reportToken: renewed.report_token });
  }
  if (!listing.is_active) {
    return res.status(409).json({ error: "Show this listing to buyers before sending it." });
  }
  if (trialOver) {
    return res.status(403).json({ error: "Your free trial has ended. Add your branch code in Settings to send homes to buyers." });
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

  const blocked = await buyersBlocking(listing.agent_id);
  const matchedIds = [...new Set((matches || []).map((m) => m.user_id))].filter(
    (id) => id !== user.id && !blocked.has(id)
  );
  // Buyers who'd have fitted but paused, found somewhere or turned this agent
  // off: calls the agent doesn't waste (agent_time_saved, migration 030).
  await recordSkipped(listing);
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

// Buyers whose household turned off homes from this agent (Settings →
// Agents, migration 030). Before that migration: nobody.
async function buyersBlocking(agentId) {
  const { data, error } = await supabaseAdmin.rpc("buyers_blocking_agent", { p_agent: agentId });
  if (error) return new Set();
  return new Set((data || []).map((row) => (typeof row === "string" ? row : Object.values(row)[0])));
}

async function recordSkipped(listing) {
  const { data: count, error } = await supabaseAdmin.rpc("buyers_skipped_for_listing", { p_listing: listing.id });
  if (error || !count) return;
  const { data: existing } = await supabaseAdmin
    .from("agent_activity")
    .select("count")
    .eq("listing_id", listing.id)
    .eq("kind", "buyers_skipped")
    .maybeSingle();
  if (existing && existing.count >= count) return;
  const { error: saveError } = await supabaseAdmin
    .from("agent_activity")
    .upsert(
      { agent_id: listing.agent_id, listing_id: listing.id, kind: "buyers_skipped", count },
      { onConflict: "listing_id,kind" }
    );
  if (saveError) console.error("agent_activity save failed:", saveError);
}

// Send one listing to these buyers: each gets it at most once (listing_sends),
// it's added to their household's list, and they get an email and a push
// with their own one-tap booking link. -> { sent, emailed, pushed }
async function deliverListing(listing, wantedIds, base) {
  // Never to a buyer who turned this agent off, whichever way we got here.
  const blocked = await buyersBlocking(listing.agent_id);
  const matchedIds = wantedIds.filter((id) => !blocked.has(id));
  if (!matchedIds.length) return { sent: 0, emailed: 0, pushed: 0 };

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

  const prefs = await emailPrefs(recipients);
  await Promise.all(
    recipients.map(async (id) => {
      const inList = Boolean(households.get(householdOf.get(id))?.property);
      // Unsubscribed from these emails: the push and the app still have it.
      const pref = prefs.get(id);
      if (pref && !pref.matches) return;
      const unsubscribe = unsubscribeLinks(base, pref?.token, "matches");

      const { data } = await supabaseAdmin.auth.admin.getUserById(id);
      const email = data?.user?.email;
      if (!email) return;

      await sendEmail({
        to: email,
        replyTo: listing.agents.email,
        subject: `New match: ${listing.address}${listing.price ? `, ${priceText(listing.price)}` : ""}`,
        html: listingEmail(listing, listing.agents, base, inList, tokenOf.get(id), unsubscribe),
        unsubscribe,
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
    // An agent whose free trial ended without a code doesn't auto-send.
    const a = listing.agents || {};
    if (a.trial_ends_at && !a.signup_code && new Date(a.trial_ends_at) < new Date()) continue;
    const result = await deliverListing(listing, [user.id], appBaseUrl(req)).catch((err) => {
      console.error("for_search delivery failed:", err);
      return { sent: 0 };
    });
    sent += result.sent;
  }
  return res.status(200).json({ success: true, sent });
}

// The vendor's view of how their home is doing: /report/<token>.
//   GET /api/send-listing?report=<report_token>
// Buyers are numbered ("Buyer 1") by the order they first booked, so the
// vendor can follow one buyer's second viewing without learning who it is.
const OFFER_TEXT = {
  awaiting_agent: "Waiting for the agent to confirm",
  confirmed: "Accepted",
  disputed: "Not confirmed by the agent",
  unverified: "Reported by the buyer",
};

async function handleSellerReport(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const token = String(req.query.report || "");
  if (!UUID_RE.test(token)) return res.status(404).json({ error: "This report link isn't valid." });

  const { data: listing, error } = await supabaseAdmin
    .from("agent_listings")
    .select(
      "id, agent_id, address, postcode, image_url, price, previous_price, price_reduced_at, bedrooms, " +
        "property_type, has_garden, market_status, created_at, agents(name, agency, branch)"
    )
    .eq("report_token", token)
    .maybeSingle();
  if (error || !listing) {
    return res.status(404).json({ error: "This report link isn't valid any more. Ask your agent for a new one." });
  }

  const [slotsResult, offersResult, pricesResult, sentResult, matchResult] = await Promise.all([
    supabaseAdmin
      .from("viewing_slots")
      .select("id, starts_at, ends_at, capacity, cancelled_at, viewing_bookings(id, buyer_email, status, created_at)")
      .eq("listing_id", listing.id)
      // Cancelled times too: their bookings still count for numbering buyers.
      .order("starts_at"),
    supabaseAdmin
      .from("offers")
      .select("amount, status, reported_at")
      .eq("agent_listing_id", listing.id)
      // Only offers the agent confirmed or is still to answer: never one
      // they disputed, or a buyer's claim they haven't seen.
      .in("status", ["confirmed", "awaiting_agent"])
      .order("reported_at"),
    supabaseAdmin
      .from("listing_price_history")
      .select("price, changed_at")
      .eq("listing_id", listing.id)
      .order("changed_at"),
    supabaseAdmin.from("listing_sends").select("user_id", { count: "exact", head: true }).eq("listing_id", listing.id),
    listing.postcode
      ? supabaseAdmin.rpc("match_buyer_searches", {
          p_postcode: listing.postcode,
          p_price: listing.price,
          p_bedrooms: listing.bedrooms,
          p_property_type: listing.property_type,
          p_has_garden: listing.has_garden,
        })
      : Promise.resolve({ data: [] }),
  ]);

  // Buyers are numbered from every booking ever made, cancelled ones too,
  // oldest first: "Buyer 1" is the first to book, and nobody's number shifts
  // when someone cancels. Only confirmed bookings on live times are shown.
  const allBookings = [];
  const bookings = [];
  for (const slot of slotsResult.data || []) {
    for (const b of slot.viewing_bookings || []) {
      allBookings.push(b);
      if (b.status === "confirmed" && !slot.cancelled_at) bookings.push({ ...b, slot });
    }
  }
  const labelOf = new Map();
  for (const b of [...allBookings].sort((x, y) => x.created_at.localeCompare(y.created_at))) {
    const key = (b.buyer_email || b.id).toLowerCase();
    if (!labelOf.has(key)) labelOf.set(key, `Buyer ${labelOf.size + 1}`);
  }
  const buyerLabel = (b) => labelOf.get((b.buyer_email || b.id).toLowerCase());
  const now = Date.now();
  const viewings = bookings
    .map((b) => ({
      at: b.slot.starts_at,
      done: new Date(b.slot.ends_at).getTime() < now,
      buyer: buyerLabel(b),
      openHouse: b.slot.capacity > 1,
    }))
    .sort((x, y) => x.at.localeCompare(y.at));

  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  let feedback = [];
  if (bookingById.size) {
    const { data } = await supabaseAdmin
      .from("viewing_feedback")
      .select("booking_id, viewing_at, answer, note")
      .in("booking_id", [...bookingById.keys()])
      .order("viewing_at");
    feedback = (data || []).map((f) => ({
      at: f.viewing_at,
      buyer: buyerLabel(bookingById.get(f.booking_id)),
      answer: f.answer,
      note: f.note || "",
    }));
  }

  // Before migration 035's history: what the listing itself remembers.
  let prices = (pricesResult.data || []).map((p) => ({ price: p.price, at: p.changed_at }));
  if (!prices.length && listing.price) {
    prices = listing.previous_price
      ? [
          { price: listing.previous_price, at: listing.created_at },
          { price: listing.price, at: listing.price_reduced_at || listing.created_at },
        ]
      : [{ price: listing.price, at: listing.created_at }];
  }

  const matching = new Set(
    (matchResult.data || []).map((m) => m.user_id).filter((id) => id && id !== listing.agent_id)
  ).size;

  return res.status(200).json({
    report: {
      address: listing.address,
      imageUrl: listing.image_url || "",
      price: listing.price,
      status: listing.market_status || "available",
      listedAt: listing.created_at,
      agent: {
        name: listing.agents?.name || "",
        agency: [listing.agents?.agency, listing.agents?.branch].filter(Boolean).join(" · "),
      },
      viewings,
      feedback,
      offers: (offersResult.data || []).map((o) => ({
        amount: o.amount,
        status: OFFER_TEXT[o.status] || o.status,
        at: o.reported_at,
      })),
      prices,
      matchingBuyers: matching,
      sentTo: sentResult.count || 0,
    },
  });
}
