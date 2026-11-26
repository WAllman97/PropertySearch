// Small display helpers for saved homes.

const PORTALS = { rightmove: "Rightmove", zoopla: "Zoopla", onthemarket: "OnTheMarket" };

// "rightmove" -> "Rightmove"; anything else as it is.
export function portalName(source) {
  return PORTALS[String(source || "").toLowerCase()] || source || "";
}

// Older saves kept the portal's headline as the address ("2 bedroom house
// for sale in Birley Street, Battersea, SW11"): show just the address.
export function cleanAddress(text) {
  return String(text || "").replace(/^.*?\bfor (?:sale|rent) in\s+/i, "").trim();
}

// The site a listing link points at, from the link itself (a home an agent
// sent, or one saved from Zoopla, is labelled by where it really goes),
// falling back to the saved source.
function portalOf(url, source) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a full link: go by the source.
  }
  const fromUrl = Object.keys(PORTALS).find((key) => host.includes(key));
  return PORTALS[fromUrl] || PORTALS[String(source || "").toLowerCase()] || null;
}

// "View on Zoopla ↗", or "View listing ↗" for any other site.
export function listingLinkLabel(source, url) {
  const name = portalOf(url, source);
  return name ? `View on ${name} ↗` : "View listing ↗";
}
