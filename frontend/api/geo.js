// Place and postcode lookups (migration 016).
//   POST /api/geo { action: "places", q }          -> { results: [{ label, lat, lng }] }
//   POST /api/geo { action: "postcode", postcode } -> { location: { lat, lng, precision } | null }
//
// "postcode" also caches the position so buyers' distance and map searches
// can match the listing. Any signed-in account can call it.
import { requireUser, underRateLimit } from "./_lib/household.js";
import { findPlaces, locatePostcode } from "./_lib/geo.js";
import { withCors } from "./_lib/cors.js";

const MAX_LOOKUPS_PER_HOUR = 300;

export default withCors(handler);

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  if (!(await underRateLimit(user.id, "geo_lookup", MAX_LOOKUPS_PER_HOUR, 60))) {
    return res.status(429).json({ error: "Too many searches. Try again in a few minutes." });
  }

  try {
    const { action } = req.body || {};
    if (action === "places") {
      return res.status(200).json({ results: await findPlaces(req.body.q) });
    }
    if (action === "postcode") {
      return res.status(200).json({ location: await locatePostcode(req.body.postcode) });
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (error) {
    console.error("geo lookup failed:", error);
    return res.status(502).json({ error: "Place search isn't working right now. Try again shortly." });
  }
}
