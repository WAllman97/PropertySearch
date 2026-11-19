// Where places and postcodes are (postcodes.io: free, no key, UK only).
// Postcode positions are cached in postcode_locations (migration 016), which
// match_buyer_searches() reads to match place/distance and map searches.
import { supabaseAdmin } from "./household.js";

const POSTCODES_IO = "https://api.postcodes.io";
const FULL_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2}$/;
const DISTRICT_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?$/;

export function normalisePostcode(text) {
  return String(text || "").toUpperCase().replace(/\s+/g, "");
}

function districtOf(pc) {
  if (FULL_RE.test(pc)) return pc.slice(0, -3);
  return DISTRICT_RE.test(pc) ? pc : null;
}

async function getJson(path) {
  const response = await fetch(`${POSTCODES_IO}${path}`, { signal: AbortSignal.timeout(8000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`postcodes.io ${response.status}`);
  return (await response.json()).result || null;
}

const hasPoint = (r) => r && typeof r.latitude === "number" && typeof r.longitude === "number";

// Make sure this postcode (and its district) has a position cached. Returns
// { lat, lng, precision: "postcode" | "district" } or null. Never throws:
// matching just falls back to the postcode district if this fails.
export async function locatePostcode(text) {
  const pc = normalisePostcode(text);
  const district = districtOf(pc);
  if (!district) return null;

  try {
    const keys = FULL_RE.test(pc) ? [pc, district] : [district];
    const { data: cached } = await supabaseAdmin
      .from("postcode_locations")
      .select("postcode, lat, lng")
      .in("postcode", keys);
    const byKey = new Map((cached || []).map((r) => [r.postcode, r]));

    const rows = [];
    if (!byKey.has(district)) {
      const outcode = await getJson(`/outcodes/${district}`);
      if (hasPoint(outcode)) {
        const row = { postcode: district, lat: outcode.latitude, lng: outcode.longitude };
        rows.push(row);
        byKey.set(district, row);
      }
    }
    if (pc !== district && !byKey.has(pc)) {
      // Terminated postcodes 404 here; the district centre still works.
      const found = await getJson(`/postcodes/${pc}`);
      if (hasPoint(found)) {
        const row = { postcode: pc, lat: found.latitude, lng: found.longitude };
        rows.push(row);
        byKey.set(pc, row);
      }
    }
    if (rows.length) {
      const { error } = await supabaseAdmin.from("postcode_locations").upsert(rows);
      if (error) console.error("postcode_locations upsert failed:", error);
    }

    const best = byKey.get(pc) || byKey.get(district);
    if (!best) return null;
    return { lat: best.lat, lng: best.lng, precision: byKey.has(pc) && pc !== district ? "postcode" : "district" };
  } catch (error) {
    console.error("locatePostcode failed:", error.message);
    return null;
  }
}

// Place-name search for the "within X miles of ..." box. A postcode or
// district typed in works too.
export async function findPlaces(query) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];

  const pc = normalisePostcode(q);
  if (districtOf(pc)) {
    const located = await locatePostcode(pc);
    if (!located) return [];
    const label = FULL_RE.test(pc) ? `${pc.slice(0, -3)} ${pc.slice(-3)}` : pc;
    return [{ label, lat: located.lat, lng: located.lng }];
  }

  const results = (await getJson(`/places?q=${encodeURIComponent(q.slice(0, 60))}&limit=10`)) || [];
  const seen = new Set();
  return results
    .filter(hasPoint)
    .map((r) => {
      const where = r.district_borough || r.county_unitary || r.region || "";
      return {
        label: where && where !== r.name_1 ? `${r.name_1}, ${where}` : r.name_1,
        lat: r.latitude,
        lng: r.longitude,
      };
    })
    .filter((r) => (seen.has(r.label) ? false : seen.add(r.label)));
}
