// Price-drop, time-on-market and sold-price helpers. The data comes from the
// daily backend job (backend/core/listing_tracker.py and sales_comps.py).

const DAY_MS = 24 * 60 * 60 * 1000;

export const STALE_DAYS = 60;
export const RECENT_REDUCTION_DAYS = 90;

export function daysSince(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / DAY_MS));
}

export function formatGBP(value) {
  if (value == null) return "—";
  return `£${Math.round(Number(value)).toLocaleString("en-GB")}`;
}

// £685k / £1.25m
export function formatShortGBP(value) {
  if (value == null) return "—";
  const n = Number(value);
  if (n >= 1_000_000) return `£${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, "")}m`;
  if (n >= 1_000) return `£${Math.round(n / 1_000)}k`;
  return `£${n}`;
}

export function formatShortDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function formatMonthYear(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

// Drop since we first saw it: { amount, pct } or null.
export function priceDrop(property) {
  const now = Number(property.price);
  const first = Number(property.initial_price);
  if (!now || !first || now >= first) return null;
  return { amount: first - now, pct: ((first - now) / first) * 100 };
}

export function daysOnMarket(property) {
  return daysSince(property.first_listed_at);
}

export function isReduced(property) {
  if (priceDrop(property)) return true;
  const since = daysSince(property.price_reduced_at);
  return since !== null && since <= RECENT_REDUCTION_DAYS;
}

export function isStale(property, days = STALE_DAYS) {
  const onMarket = daysOnMarket(property);
  return onMarket !== null && onMarket >= days;
}

// Asking vs local sold median, in %, using today's price (comps may be
// up to 30 days old, the price may have changed since).
export function askingVsMedian(property) {
  const median = property.comps?.median;
  const price = Number(property.price);
  if (!median || !price) return null;
  return (price / median - 1) * 100;
}

export function hasComps(property) {
  return Boolean(property.comps?.median);
}

export const LISTING_STATUS_LABELS = {
  removed: "Off the market",
  sold_stc: "Sold STC",
  under_offer: "Under offer",
};

export const MARKET_FILTERS = [
  { key: "all", label: "All" },
  { key: "reduced", label: "Reduced", test: isReduced },
  { key: "stale", label: `On market ${STALE_DAYS}+ days`, test: (p) => isStale(p) },
  {
    key: "below_local",
    label: "At or below local median",
    test: (p) => {
      const diff = askingVsMedian(p);
      return diff !== null && diff <= 0;
    },
  },
];

export const MARKET_SORTS = [
  { key: "newest", label: "Newest" },
  // Listings with no price always sort last.
  {
    key: "price_low",
    label: "Price: low to high",
    compare: (a, b) => (a.price || Infinity) - (b.price || Infinity),
  },
  {
    key: "price_high",
    label: "Price: high to low",
    compare: (a, b) => (b.price || -Infinity) - (a.price || -Infinity),
  },
  {
    key: "biggest_drop",
    label: "Biggest price cut",
    compare: (a, b) => (priceDrop(b)?.pct ?? -1) - (priceDrop(a)?.pct ?? -1),
  },
  {
    key: "longest_listed",
    label: "Longest on market",
    compare: (a, b) => (daysOnMarket(b) ?? -1) - (daysOnMarket(a) ?? -1),
  },
  {
    key: "best_value",
    label: "Best value vs local sales",
    compare: (a, b) => (askingVsMedian(a) ?? 999) - (askingVsMedian(b) ?? 999),
  },
];

export function applyMarketView(properties, filterKey, sortKey) {
  const filter = MARKET_FILTERS.find((f) => f.key === filterKey);
  const sort = MARKET_SORTS.find((s) => s.key === sortKey);
  const filtered = filter?.test ? properties.filter(filter.test) : properties;
  return sort?.compare ? [...filtered].sort(sort.compare) : filtered;
}
