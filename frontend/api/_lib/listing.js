// Portal + listing id from a listing URL, e.g. "rightmove:123456789".
// Must match listing_key() in backend/migrations/006_agent_viewings.sql.
const PATTERNS = [
  ["rightmove", /rightmove\.co\.uk\/properties\/([0-9]+)/i],
  ["zoopla", /zoopla\.co\.uk\/.*details\/([0-9]+)/i],
  ["onthemarket", /onthemarket\.com\/details\/([0-9]+)/i],
];

export function listingKey(url) {
  for (const [portal, pattern] of PATTERNS) {
    const match = String(url || "").match(pattern);
    if (match) return `${portal}:${match[1]}`;
  }
  return null;
}
