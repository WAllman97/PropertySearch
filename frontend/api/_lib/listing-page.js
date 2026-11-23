// Read one portal listing's link preview into the fields a property needs.
// Used by /api/lookup when a buyer saves a link: one page, on request.
//
// Only the link-preview tags are used (og:title, og:description, og:image,
// the page title and meta description): the summary portals publish so that
// messaging apps can show a preview when a link is shared. Nothing else on
// the page is read, and nothing is crawled. The buyer checks the details and
// fills in anything missing.
//
// We only ever fetch a URL we build ourselves from the listing id, so a
// pasted link can't point the server at anything else.

// Says who we are, like any messaging app's link preview, rather than
// posing as a browser (docs/DATA_SOURCES.md). Vercel can override it.
const UA =
  process.env.LINK_PREVIEW_USER_AGENT ||
  "PropertySearchLinkPreview/1.0 (+https://property-search-4jcc.vercel.app/support)";

// Off switch: PORTAL_PREVIEWS=off in Vercel stops every portal fetch at once
// (say a portal asks us to). Saving a link still works: the buyer or agent
// types the details, and agents' own listings on PropertySearch fill in as
// before, since they never needed the portal.
export const portalPreviewsOn = () => String(process.env.PORTAL_PREVIEWS || "on").toLowerCase() !== "off";
const TIMEOUT_MS = 8000;
const MAX_BYTES = 600000;

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

function decode(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&pound;|&#163;|&#xa3;/gi, "£")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// <meta property|name="..." content="..."> in either attribute order.
function metaTags(html) {
  const tags = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i);
    if (name && content && !(name in tags)) tags[name] = decode(content[1] ?? content[2]);
  }
  return tags;
}

const POSTCODE_RE = /\b([A-Z]{1,2}[0-9][0-9A-Z]?)(?:\s*([0-9][A-Z]{2}))?\b/;

// "2 bedroom terraced house for sale in Eversleigh Road, London, SW11 for
// £780,000. Marketed by Savills, Battersea Park"
export function parseLinkPreview(html) {
  const tags = metaTags(html);
  const title = decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]);
  const summary = tags["og:description"] || tags["twitter:description"] || tags.description || title;
  if (!summary || /page not found|not available|no longer/i.test(`${summary} ${title}`)) return null;

  const text = `${summary} ${title}`;
  const beds = text.match(/\b(\d{1,2})\s*bed(?:room)?s?\b/i);
  const studio = /\bstudio\b/i.test(text);
  const price = summary.match(/£\s?([\d,]{4,})/) || text.match(/£\s?([\d,]{4,})/);
  const address =
    summary.match(/for sale in (.+?)(?: for £| - |\.\s|$)/i)?.[1] ||
    title.match(/for sale in (.+?)(?: - |\||$)/i)?.[1] ||
    "";
  const postcode = address.toUpperCase().match(POSTCODE_RE);
  const agent = summary.match(/Marketed by ([^.]+)/i)?.[1];
  const image = tags["og:image"] || tags["twitter:image"] || tags["twitter:image:src"] || "";

  if (!address && !price) return null;
  return {
    address: address.replace(/\s*,\s*$/, "").slice(0, 200),
    postcode: postcode ? [postcode[1], postcode[2]].filter(Boolean).join(" ") : null,
    price: price ? Number(price[1].replace(/,/g, "")) : null,
    bedrooms: studio ? 0 : beds ? Number(beds[1]) : null,
    property_type: normalisePropertyType(summary, title),
    // A site-wide sharing picture isn't a photo of the home.
    image_url: /^https:\/\//.test(image) && !/social|sharing|logo|default/i.test(image) ? image : "",
    agent_name: agent ? agent.trim().slice(0, 100) : null,
    // Only a "yes" when the summary says so. Silence doesn't mean no garden.
    has_garden: /\bno garden\b/i.test(text) ? false : /\bgardens?\b/i.test(text) ? true : null,
    description: summary.slice(0, 500),
    listing_status: /sold stc|sold subject to contract/i.test(text)
      ? "sold_stc"
      : /under offer/i.test(text)
        ? "under_offer"
        : "live",
  };
}

// -> { status: "ok" | "blocked" | "failed", details }
export async function fetchListingDetails(key) {
  const url = canonicalListingUrl(key);
  if (!url) return { status: "failed", details: {} };
  if (!portalPreviewsOn()) return { status: "off", details: {} };

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
    // The preview tags are in the page head: no need for the rest.
    const html = (await response.text()).slice(0, MAX_BYTES);
    details = parseLinkPreview(html);
  } catch (error) {
    console.error(`Link preview parse failed for ${key}:`, error.message);
  }
  if (!details) return { status: "failed", details: {} };
  return { status: "ok", details };
}
