// Read one portal listing page into the fields a property needs. Used by
// /api/listing-preview when a buyer saves a link: one page, on request, like
// a link preview. Never crawls search results.
//
// We only ever fetch a URL we build ourselves from the listing id, so a
// pasted link can't point the server at anything else.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const TIMEOUT_MS = 8000;
const GARDEN_RE = /\b(garden|patio|courtyard|terrace|outside space|yard)\b/i;

export function canonicalListingUrl(key) {
  const [portal, id] = String(key || "").split(":");
  if (!/^[0-9]+$/.test(id || "")) return null;
  if (portal === "rightmove") return `https://www.rightmove.co.uk/properties/${id}`;
  if (portal === "zoopla") return `https://www.zoopla.co.uk/for-sale/details/${id}/`;
  if (portal === "onthemarket") return `https://www.onthemarket.com/details/${id}/`;
  return null;
}

// Mirrors backend/core/listing_tracker.py normalise_property_type: the same
// values the sold-price comparisons use.
export function normalisePropertyType(...texts) {
  for (const text of texts) {
    const s = String(text || "").toLowerCase();
    if (!s) continue;
    if (/flat|apartment|maisonette|penthouse|studio|duplex/.test(s)) return "flat";
    if (/semi[\s-]?detached/.test(s)) return "semi-detached";
    if (/terrace|mews|town ?house/.test(s)) return "terraced";
    if (s.includes("detached")) return "detached";
    if (/house|bungalow|cottage/.test(s)) return "house";
  }
  return null;
}

function priceFromText(text) {
  const digits = String(text || "").replace(/[^0-9]/g, "");
  return digits ? Number(digits) : null;
}

function cleanText(text, max = 1500) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// --- Rightmove: window.__PAGE_MODEL is a flattened graph (keys -> indices).

function extractJsonObject(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  return null;
}

function hydrate(arr) {
  const memo = new Map();
  function resolve(idx, depth) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length || depth > 80) return null;
    if (memo.has(idx)) return memo.get(idx);
    const value = arr[idx];
    if (Array.isArray(value)) {
      const out = [];
      memo.set(idx, out);
      for (const ref of value) out.push(resolve(ref, depth + 1));
      return out;
    }
    if (value && typeof value === "object") {
      const out = {};
      memo.set(idx, out);
      for (const [key, ref] of Object.entries(value)) out[key] = resolve(ref, depth + 1);
      return out;
    }
    return value;
  }
  return resolve(0, 0);
}

export function parseRightmove(html) {
  const model = extractJsonObject(html, "window.__PAGE_MODEL");
  if (!model?.data) return null;
  const pd = hydrate(JSON.parse(model.data))?.propertyData;
  if (!pd) return null;

  const address = pd.address || {};
  const features = (pd.keyFeatures || []).filter(Boolean);
  const description = cleanText(pd.text?.description);
  const gardenFlag = pd.features?.garden?.[0]?.displayText;
  const tags = (pd.tags || []).join(" ").toUpperCase();

  return {
    address: address.displayAddress || null,
    postcode:
      address.outcode && address.incode ? `${address.outcode} ${address.incode}`.toUpperCase() : null,
    price: priceFromText(pd.prices?.primaryPrice),
    bedrooms: Number.isInteger(pd.bedrooms) ? pd.bedrooms : null,
    property_type: normalisePropertyType(pd.propertySubType),
    has_garden:
      gardenFlag === "Yes" ? true : gardenFlag === "No" ? false : GARDEN_RE.test(features.join(" ")) || null,
    image_url: pd.images?.[0]?.url || null,
    latitude: pd.location?.latitude ?? null,
    longitude: pd.location?.longitude ?? null,
    description: cleanText([features.join(". "), description].filter(Boolean).join("\n\n"), 5000),
    listing_status: pd.status?.archived || pd.status?.published === false
      ? "removed"
      : /SOLD_STC|SOLD STC/.test(tags)
        ? "sold_stc"
        : /UNDER_OFFER|UNDER OFFER/.test(tags)
          ? "under_offer"
          : "live",
  };
}

// --- OnTheMarket: Next.js page, property in initialReduxState.

export function parseOnTheMarket(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  const p = JSON.parse(match[1])?.props?.pageProps?.initialReduxState?.property;
  if (!p?.id) return null;

  const features = (p.features || []).map((f) => f?.feature).filter(Boolean);
  const description = cleanText(p.description);

  return {
    address: p.displayAddress || null,
    postcode: null, // not on the page; filled from the map pin below
    price: Number.isFinite(p.priceRaw) ? p.priceRaw : priceFromText(p.price),
    bedrooms: Number.isInteger(p.bedrooms) ? p.bedrooms : null,
    property_type: normalisePropertyType(p.humanisedPropertyType, p.propertyTitle),
    has_garden: GARDEN_RE.test(`${features.join(" ")} ${description}`) || null,
    image_url: p.images?.[0]?.largeUrl || null,
    latitude: p.location?.lat ?? null,
    longitude: p.location?.lon ?? null,
    description: cleanText([features.join(". "), description].filter(Boolean).join("\n\n"), 5000),
    listing_status: p.retracted ? "removed" : "live",
  };
}

// Nearest postcode to the listing's map pin (postcodes.io, free open data).
// Portals often place the pin approximately, so this is right to the
// district (what search matching uses) more than to the exact door.
async function postcodeNear(lat, lon) {
  if (lat == null || lon == null) return null;
  try {
    const response = await fetch(
      `https://api.postcodes.io/postcodes?lon=${encodeURIComponent(lon)}&lat=${encodeURIComponent(lat)}&limit=1`,
      { signal: AbortSignal.timeout(4000) }
    );
    const body = await response.json();
    return body?.result?.[0]?.postcode || null;
  } catch {
    return null;
  }
}

// -> { status: "ok" | "blocked" | "failed", details }
export async function fetchListingDetails(key) {
  const url = canonicalListingUrl(key);
  if (!url) return { status: "failed", details: {} };
  const portal = key.split(":")[0];

  let response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "en-GB", Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { status: "failed", details: {} };
  }

  if (response.status === 403 || response.status === 429) return { status: "blocked", details: {} };
  if (response.status === 404 || response.status === 410) {
    return { status: "failed", details: { listing_status: "removed" } };
  }
  if (!response.ok) return { status: "failed", details: {} };

  let details = null;
  try {
    const html = await response.text();
    details = portal === "rightmove" ? parseRightmove(html) : portal === "onthemarket" ? parseOnTheMarket(html) : null;
  } catch (error) {
    console.error(`Listing page parse failed for ${key}:`, error.message);
  }
  if (!details) return { status: "failed", details: {} };

  if (!details.postcode) details.postcode = await postcodeNear(details.latitude, details.longitude);
  return { status: "ok", details };
}
