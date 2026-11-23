// Save-a-link: details for one pasted Rightmove / OnTheMarket / Zoopla link.
//   POST /api/lookup { action: "listing", url }   (routed from ../lookup.js)
//
// Cheapest source first, so each listing is read from a portal at most once
// for everyone (migration 011):
//   1. an agent on PropertySearch listed it -> their details, no fetch
//   2. listing_cache has it                 -> stored copy
//   3. read that one page's link-preview tags now (what messaging apps show
//      when a link is shared; _lib/listing-page.js) and cache the result
// Zoopla refuses automated reads, so those come back "blocked" and the
// buyer types the few details in. Portal pages are never read on a
// schedule for buyers: only when they paste a link.
import { requireHouseholdUser, requireUser, supabaseAdmin, underRateLimit } from "./household.js";
import { listingKey } from "./listing.js";
import { canonicalListingUrl, fetchListingDetails, normalisePropertyType } from "./listing-page.js";

const OK_TTL_HOURS = 72;
const RETRY_TTL_HOURS = 12;
const MAX_FETCHES_PER_HOUR = 30;

function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}

async function fromAgentListing(key) {
  const { data } = await supabaseAdmin
    .from("agent_listings")
    .select("address, postcode, price, bedrooms, property_type, has_garden, image_url, notes")
    .eq("listing_key", key)
    .eq("is_active", true)
    .not("postcode", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    address: data.address,
    postcode: data.postcode,
    price: data.price,
    bedrooms: data.bedrooms,
    // Agents pick house/flat/bungalow; map to the comps vocabulary.
    property_type: normalisePropertyType(data.property_type),
    has_garden: data.has_garden,
    image_url: data.image_url,
    description: data.notes || "",
    listing_status: "live",
  };
}

// Is it already in the household's list? Matched by portal id, so other URL
// forms of the same listing count.
async function existingProperty(key, householdId) {
  const id = key.split(":")[1];
  const { data } = await supabaseAdmin
    .from("properties")
    .select("id, status, listing_url")
    .eq("household_id", householdId)
    .ilike("listing_url", `%${id}%`);
  const hit = (data || []).find((p) => listingKey(p.listing_url) === key);
  return hit ? { id: hit.id, status: hit.status } : null;
}

// An estate agent adding their own listing in the agent portal. Agents have
// no household, so they're checked against the agents table instead.
async function requireAgentUser(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  const { data: agent } = await supabaseAdmin
    .from("agents")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!agent) {
    res.status(403).json({ error: "This account doesn't have access" });
    return null;
  }
  return user;
}

export async function handleListingPreview(req, res) {
  const forAgent = req.body?.for === "agent";
  const user = forAgent ? await requireAgentUser(req, res) : await requireHouseholdUser(req, res);
  if (!user) return;

  const url = typeof req.body?.url === "string" ? req.body.url.trim().slice(0, 500) : "";
  const key = listingKey(url);
  if (!key) {
    return res.status(400).json({
      error: "That doesn't look like a Rightmove, OnTheMarket or Zoopla property link.",
    });
  }

  const [portal, listingId] = key.split(":");
  const base = {
    key,
    portal,
    listingId,
    listingUrl: canonicalListingUrl(key),
    existing: forAgent ? null : await existingProperty(key, user.householdId),
  };

  // Agents are entering this listing themselves, so skip other agents' copies.
  const agent = forAgent ? null : await fromAgentListing(key);
  if (agent) return res.status(200).json({ ...base, status: "ok", from: "agent", details: agent });

  const { data: cached } = await supabaseAdmin
    .from("listing_cache")
    .select("status, details, fetched_at")
    .eq("listing_key", key)
    .maybeSingle();

  const fresh =
    cached &&
    hoursSince(cached.fetched_at) < (cached.status === "ok" ? OK_TTL_HOURS : RETRY_TTL_HOURS);
  if (fresh) {
    return res
      .status(200)
      .json({ ...base, status: cached.status, from: "cache", details: cached.details });
  }

  if (!(await underRateLimit(user.id, "listing_preview", MAX_FETCHES_PER_HOUR, 60))) {
    return res.status(200).json({ ...base, status: "blocked", from: "limit", details: {} });
  }

  const result = await fetchListingDetails(key);
  const { error } = await supabaseAdmin.from("listing_cache").upsert({
    listing_key: key,
    status: result.status,
    details: result.details,
    fetched_at: new Date().toISOString(),
  });
  if (error) console.error("listing_cache write failed:", error);

  return res.status(200).json({ ...base, status: result.status, from: "portal", details: result.details });
}
