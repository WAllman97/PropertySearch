// Lookups, all POST, signed in:
//   { action: "listing", url }           details for a pasted listing link (buyers)
//   { action: "places", q }              place-name search for distance searches
//   { action: "postcode", postcode }     where a postcode is, cached for matching
//
// One route on purpose: Vercel's Hobby plan allows at most 12 functions
// (files directly in api/) per deployment. Add new actions to an existing
// route like this rather than new files. See docs/IOS_APP.md / README.
import { requireUser, underRateLimit } from "./_lib/household.js";
import { findPlaces, locatePostcode } from "./_lib/geo.js";
import { handleListingPreview } from "./_lib/listing-preview.js";
import { withCors } from "./_lib/cors.js";

const MAX_GEO_LOOKUPS_PER_HOUR = 300;

export default withCors(handler);

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const action = req.body?.action;
  if (action === "listing") return handleListingPreview(req, res);
  if (action !== "places" && action !== "postcode") {
    return res.status(400).json({ error: "Unknown action" });
  }

  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await underRateLimit(user.id, "geo_lookup", MAX_GEO_LOOKUPS_PER_HOUR, 60))) {
    return res.status(429).json({ error: "Too many searches. Try again in a few minutes." });
  }

  try {
    if (action === "places") {
      return res.status(200).json({ results: await findPlaces(req.body.q) });
    }
    return res.status(200).json({ location: await locatePostcode(req.body.postcode) });
  } catch (error) {
    console.error("geo lookup failed:", error);
    return res.status(502).json({ error: "Place search isn't working right now. Try again shortly." });
  }
}
