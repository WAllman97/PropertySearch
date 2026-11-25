// The "offer accepted" step (migration 015).
//   POST /api/offers { action: "report", propertyId, amount }     buyer
//   POST /api/offers { action: "withdraw", offerId }              buyer
//   POST /api/offers { action: "respond", offerId, confirm }      agent
//   POST /api/offers { action: "offer_details", token }            agent, no login
//   POST /api/offers { action: "offer_answer", token, confirm, underOffer }
//        the agent answers from the email's private link (/offer/<token>,
//        migration 027), and can mark the home Under offer in the same tap
//
// A buyer's word alone isn't proof, so an offer only counts as verified when
// the agent selling the home confirms it. If the home is one of an agent's
// listings on PropertySearch, that agent is emailed and asked; otherwise the
// offer stays "unverified".
import { householdMemberIds, requireHouseholdUser, requireUser, supabaseAdmin, underRateLimit } from "./_lib/household.js";
import { appBaseUrl } from "./_lib/booking.js";
import { emailLayout, escapeHtml, sendEmail } from "./_lib/email.js";
import { listingKey } from "./_lib/listing.js";
import { detailRow } from "./_lib/viewings.js";
import { sendToUsers } from "./_lib/push.js";
import { withCors } from "./_lib/cors.js";
import { passStatusToBuyers } from "./_lib/agent-status.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REPORTS_PER_DAY = 10;

function pounds(amount) {
  return `£${Number(amount).toLocaleString("en-GB")}`;
}

export default withCors(handler);

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const action = req.body?.action;
    if (action === "report") return await handleReport(req, res);
    if (action === "withdraw") return await handleWithdraw(req, res);
    if (action === "respond") return await handleRespond(req, res);
    if (action === "offer_details") return await handleOfferDetails(req, res);
    if (action === "offer_answer") return await handleOfferAnswer(req, res);
    return res.status(400).json({ error: "Unknown action" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
}

// The agent listing on PropertySearch for this home, if there is one.
async function findAgentListing(listingUrl) {
  const key = listingKey(listingUrl);
  if (!key) return null;
  const { data } = await supabaseAdmin
    .from("agent_listings")
    .select("id, address, agent_id, agents(name, email)")
    .eq("listing_key", key)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(2);
  // Two agents actively listing the same home: we can't tell whose sale it
  // is, so ask neither rather than send the buyer's offer to the wrong one.
  if (!data || data.length !== 1) return null;
  return data[0];
}

async function handleReport(req, res) {
  const user = await requireHouseholdUser(req, res);
  if (!user) return;

  const { propertyId } = req.body;
  const amount = Math.round(Number(req.body.amount));
  if (!UUID_RE.test(String(propertyId || ""))) {
    return res.status(400).json({ error: "Missing property" });
  }
  if (!Number.isFinite(amount) || amount < 1000 || amount >= 100000000) {
    return res.status(400).json({ error: "Enter the accepted offer in pounds, e.g. 625000" });
  }

  const { data: property } = await supabaseAdmin
    .from("properties")
    .select("id, address, listing_url")
    .eq("id", propertyId)
    .eq("household_id", user.householdId)
    .maybeSingle();
  if (!property) {
    return res.status(404).json({ error: "Property not found" });
  }

  if (!(await underRateLimit(user.id, "offer_report", MAX_REPORTS_PER_DAY, 24 * 60))) {
    return res.status(429).json({ error: "Too many offers reported today. Please try again tomorrow." });
  }

  const listing = await findAgentListing(property.listing_url);

  const { data: offer, error } = await supabaseAdmin
    .from("offers")
    .insert({
      household_id: user.householdId,
      property_id: property.id,
      agent_listing_id: listing?.id || null,
      amount,
      reported_by: user.id,
      status: listing ? "awaiting_agent" : "unverified",
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "There's already an accepted offer on this home. Withdraw it first." });
    }
    console.error("offer insert failed:", error);
    return res.status(500).json({ error: "Could not save the offer" });
  }

  await supabaseAdmin
    .from("properties")
    .update({ status: "offer_accepted" })
    .eq("id", property.id)
    .eq("household_id", user.householdId);

  // Ask the agent to confirm. Reply goes straight to the buyer.
  if (listing?.agent_id) {
    sendToUsers([listing.agent_id], {
      title: "Offer to confirm",
      body: `A buyer says you've accepted ${pounds(amount)} on ${listing.address}. One tap to confirm.`,
      url: offer.agent_token ? `/offer/${offer.agent_token}` : "/agent",
    }).catch((err) => console.error("offer push failed:", err));
  }
  if (listing?.agents?.email) {
    const buyerName = user.user_metadata?.name || user.email;
    await sendEmail({
      to: listing.agents.email,
      replyTo: user.email,
      subject: `Please confirm: offer accepted on ${listing.address}`,
      html: emailLayout(
        "A buyer says you've accepted their offer",
        `<table style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">
          ${detailRow("Property", `<strong>${escapeHtml(listing.address)}</strong>`)}
          ${detailRow("Buyer", escapeHtml(buyerName))}
          ${detailRow("Offer", escapeHtml(pounds(amount)))}
        </table>
        <p style="margin:0 0 16px;">Is this right? It takes one tap, no login, and you can mark the
        home Under offer at the same time.</p>
        <p style="margin:0;"><a href="${escapeHtml(
          offer.agent_token ? `${appBaseUrl(req)}/offer/${offer.agent_token}` : `${appBaseUrl(req)}/agent`
        )}" style="background:#223a33;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">Confirm or correct</a></p>`
      ),
    }).catch((err) => console.error("offer email failed:", err));
  }

  // Found somewhere: every agent stops sending homes and sees it, without the
  // buyer having to tell each one (migration 029). One tap undoes it.
  const foundHome = await setSearchStatus(user.householdId, "found");

  // Never hand the agent's private link back to the buyer: with it they could
  // "confirm" their own offer as if they were the agent.
  const { agent_token: _agentToken, ...ownOffer } = offer;
  return res.status(200).json({ success: true, offer: ownOffer, foundHome });
}

// The household's search status (migration 029). Before that migration the
// columns don't exist: log it and carry on, the offer itself is saved.
async function setSearchStatus(householdId, status, onlyIf) {
  let query = supabaseAdmin
    .from("households")
    .update({ search_status: status, paused_until: null, search_status_at: new Date().toISOString() })
    .eq("id", householdId);
  if (onlyIf) query = query.eq("search_status", onlyIf);
  const { data, error } = await query.select("id");
  if (error) {
    console.error("search status update failed:", error);
    return false;
  }
  return Boolean(data?.length);
}

async function handleWithdraw(req, res) {
  const user = await requireHouseholdUser(req, res);
  if (!user) return;

  const { offerId } = req.body;
  if (!UUID_RE.test(String(offerId || ""))) {
    return res.status(400).json({ error: "Missing offer" });
  }

  const { data: offer } = await supabaseAdmin
    .from("offers")
    .update({ status: "withdrawn", withdrawn_at: new Date().toISOString() })
    .eq("id", offerId)
    .eq("household_id", user.householdId)
    .neq("status", "withdrawn")
    .select("property_id")
    .maybeSingle();
  if (!offer) {
    return res.status(404).json({ error: "Offer not found" });
  }

  await supabaseAdmin
    .from("properties")
    .update({ status: "offer_made" })
    .eq("id", offer.property_id)
    .eq("household_id", user.householdId)
    .eq("status", "offer_accepted");

  // The sale fell through: looking again, unless another accepted offer is
  // still going.
  const { count: stillAccepted } = await supabaseAdmin
    .from("offers")
    .select("id", { count: "exact", head: true })
    .eq("household_id", user.householdId)
    .neq("status", "withdrawn");
  const lookingAgain = !stillAccepted && (await setSearchStatus(user.householdId, "searching", "found"));

  return res.status(200).json({ success: true, lookingAgain });
}

async function handleRespond(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const { offerId } = req.body;
  if (!UUID_RE.test(String(offerId || "")) || typeof req.body.confirm !== "boolean") {
    return res.status(400).json({ error: "Missing offer or answer" });
  }

  const { data: offer } = await supabaseAdmin
    .from("offers")
    .select("id, household_id, amount, status, agent_listings(agent_id, address)")
    .eq("id", offerId)
    .maybeSingle();

  // Only the agent whose listing it is can answer. Agents may correct an
  // earlier answer, but not one the buyer has withdrawn.
  if (!offer || offer.agent_listings?.agent_id !== user.id || offer.status === "withdrawn") {
    return res.status(404).json({ error: "Offer not found" });
  }

  const status = await answerOffer(offer, req.body.confirm);
  if (!status) return res.status(500).json({ error: "Could not save your answer" });
  return res.status(200).json({ success: true, status });
}

// Save the agent's answer and tell the buyer's household. -> status or null
async function answerOffer(offer, confirm) {
  const status = confirm ? "confirmed" : "disputed";
  const { error } = await supabaseAdmin
    .from("offers")
    .update({ status, agent_responded_at: new Date().toISOString() })
    .eq("id", offer.id);
  if (error) {
    console.error("offer respond failed:", error);
    return null;
  }

  const address = offer.agent_listings.address;
  await sendToUsers(await householdMemberIds(offer.household_id), {
    title: confirm ? `Offer confirmed: ${address}` : `Agent queried your offer: ${address}`,
    body: confirm
      ? `The agent confirmed your accepted offer of ${pounds(offer.amount)}.`
      : `The agent says the accepted offer of ${pounds(offer.amount)} isn't right. Tap to check.`,
    url: "/?view=history",
  }).catch((err) => console.error("offer push failed:", err));
  return status;
}

async function loadOfferByToken(token) {
  if (!UUID_RE.test(String(token || ""))) return null;
  const { data } = await supabaseAdmin
    .from("offers")
    .select(
      "id, household_id, amount, status, reported_at, reported_by, agent_listings(id, agent_id, address, listing_url, image_url, market_status)"
    )
    .eq("agent_token", token)
    .maybeSingle();
  return data?.agent_listings ? data : null;
}

// What the agent sees on /offer/<token>: the home, the buyer, the amount.
async function handleOfferDetails(req, res) {
  const offer = await loadOfferByToken(req.body?.token);
  if (!offer) return res.status(404).json({ error: "This link isn't valid any more" });
  let buyerName = "The buyer";
  if (offer.reported_by) {
    const { data } = await supabaseAdmin.auth.admin.getUserById(offer.reported_by);
    buyerName = data?.user?.user_metadata?.name || data?.user?.email || buyerName;
  }
  const listing = offer.agent_listings;
  return res.status(200).json({
    offer: {
      status: offer.status,
      amount: offer.amount,
      reportedAt: offer.reported_at,
      buyerName,
      address: listing.address,
      imageUrl: listing.image_url,
      marketStatus: listing.market_status,
    },
  });
}

async function handleOfferAnswer(req, res) {
  const offer = await loadOfferByToken(req.body?.token);
  if (!offer || offer.status === "withdrawn") {
    return res.status(404).json({ error: "This offer has been withdrawn by the buyer" });
  }
  if (typeof req.body.confirm !== "boolean") return res.status(400).json({ error: "Missing answer" });

  const status = await answerOffer(offer, req.body.confirm);
  if (!status) return res.status(500).json({ error: "Could not save your answer" });

  // Confirmed, and the agent ticked "mark it Under offer": do that too, and
  // tell everyone else who saved the home.
  let underOffer = false;
  const listing = offer.agent_listings;
  if (req.body.confirm && req.body.underOffer && listing.market_status === "available") {
    const { error } = await supabaseAdmin
      .from("agent_listings")
      .update({ market_status: "under_offer" })
      .eq("id", listing.id);
    if (!error) {
      underOffer = true;
      await passStatusToBuyers({ ...listing, market_status: "under_offer" }).catch((err) =>
        console.error("under offer update failed:", err)
      );
    }
  }
  return res.status(200).json({ success: true, status, underOffer });
}
