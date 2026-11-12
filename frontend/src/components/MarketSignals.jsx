import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import {
  LISTING_STATUS_LABELS,
  STALE_DAYS,
  askingVsMedian,
  daysOnMarket,
  daysSince,
  formatGBP,
  formatMonthYear,
  formatShortDate,
  formatShortGBP,
  priceDrop,
} from "../utils/market";
import "./MarketSignals.css";

const TYPE_WORDS = {
  flat: "flat",
  terraced: "terraced",
  "semi-detached": "semi-detached",
  detached: "detached",
  house: "house",
  all: "residential",
};

// "9 2-bed terraced sales within 402m, last 24 months"
function compsBasis(comps) {
  const type = TYPE_WORDS[comps.type_basis] || comps.type_basis;
  const beds = comps.bedrooms_basis ? `${comps.bedrooms_basis}-bed ` : "";
  const plural = comps.count === 1 ? "" : "s";
  let text = `${comps.count} ${beds}${type} sale${plural} within ${comps.radius_m}m, last ${comps.window_months} months`;
  if (comps.method !== "bedrooms") text += " · any size, not bedroom-matched";
  if (comps.low_confidence) text += " · few sales, rough guide";
  return text;
}

function onMarketClass(days) {
  if (days >= 120) return "signal-hot";
  if (days >= STALE_DAYS) return "signal-warm";
  return "signal-neutral";
}

// A modest discount to similar sales is a good sign; a very large one
// usually means the comparison isn't like-for-like (condition, lease,
// size, estate vs period housing), so flag it rather than celebrate it.
const BIG_GAP_PCT = 20;

function vsClass(pct) {
  if (pct <= -BIG_GAP_PCT) return "signal-warm";
  if (pct <= -3) return "signal-good";
  if (pct >= 10) return "signal-bad";
  return "signal-neutral";
}

function PriceBadges({ property }) {
  const drop = priceDrop(property);
  const reducedDays = daysSince(property.price_reduced_at);
  const onMarket = daysOnMarket(property);
  const statusLabel = LISTING_STATUS_LABELS[property.listing_status];

  if (!drop && reducedDays === null && onMarket === null && !statusLabel) return null;

  return (
    <div className="market-badges">
      {statusLabel && <span className="market-badge signal-bad">{statusLabel}</span>}

      {drop ? (
        <span
          className="market-badge signal-good"
          title={`First seen at ${formatGBP(property.initial_price)}`}
        >
          ↓ {formatShortGBP(drop.amount)} ({drop.pct.toFixed(1)}%)
          {/* Rightmove's own reduction date when known; otherwise the day we saw it. */}
          {(property.price_reduced_at || property.last_price_change_at) &&
            ` · ${formatShortDate(property.price_reduced_at || property.last_price_change_at)}`}
        </span>
      ) : (
        reducedDays !== null && (
          <span className="market-badge signal-good" title="Rightmove's latest reduction date">
            Reduced {formatShortDate(property.price_reduced_at)}
          </span>
        )
      )}

      {onMarket !== null && (
        <span
          className={`market-badge ${onMarketClass(onMarket)}`}
          title={`First listed ${formatShortDate(property.first_listed_at)}`}
        >
          {onMarket === 0 ? "Listed today" : `On market ${onMarket}d`}
        </span>
      )}
    </div>
  );
}

function CompsDetail({ property, history }) {
  const comps = property.comps;

  return (
    <div className="market-detail">
      {history && history.length > 1 && (
        <>
          <h4>Asking price history</h4>
          <ul className="market-list">
            {history.map((row) => (
              <li key={row.id}>
                <span>{formatShortDate(row.observed_at)} {new Date(row.observed_at).getFullYear()}</span>
                <strong>{formatGBP(row.price)}</strong>
              </li>
            ))}
          </ul>
        </>
      )}

      {comps?.sales?.length > 0 && (
        <>
          <h4>Nearest recent sales</h4>
          <ul className="market-list">
            {comps.sales.map((sale, index) => (
              <li key={`${sale.address}-${sale.date}-${index}`}>
                <span>
                  {sale.address || "Address withheld"}, {sale.postcode}
                  <small>
                    {formatMonthYear(sale.date)} ·{" "}
                    {sale.bedrooms != null ? `${sale.bedrooms} bed ` : ""}
                    {sale.type?.replace("-maisonette", "")} · {sale.tenure}
                    {sale.new_build ? " · new build" : ""}
                    {sale.distance_m != null ? ` · ${sale.distance_m}m` : ""}
                  </small>
                </span>
                <strong>{formatGBP(sale.price)}</strong>
              </li>
            ))}
          </ul>
          <p className="market-footnote">
            Middle half of sales: {formatShortGBP(comps.p25)}–{formatShortGBP(comps.p75)}.{" "}
            {comps.method === "bedrooms"
              ? "Matched on property type and bedrooms; condition, size and garden still vary."
              : "Land Registry doesn't record bedrooms or size, so treat this as a rough guide."}{" "}
            Latest sale {formatMonthYear(comps.latest_sale_date)}.
            <br />
            Contains HM Land Registry data © Crown copyright and database right. Licensed under
            the Open Government Licence v3.0.
          </p>
        </>
      )}
    </div>
  );
}

function MarketSignals({ property, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [history, setHistory] = useState(null);

  const comps = property.comps;
  const vs = askingVsMedian(property);
  // Something to show beyond the summary: nearby sales, or a price change.
  const hasDetail =
    Boolean(comps?.sales?.length) ||
    Boolean(property.last_price_change_at) ||
    Boolean(priceDrop(property));

  async function loadHistory() {
    const { data } = await supabase
      .from("price_history")
      .select("id, price, observed_at")
      .eq("property_id", property.id)
      .order("observed_at", { ascending: true });
    setHistory(data || []);
  }

  // Detail view opens expanded: load the history straight away.
  useEffect(() => {
    if (defaultOpen) loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property.id, defaultOpen]);

  function toggle(event) {
    event.stopPropagation();
    const next = !open;
    setOpen(next);
    if (next && history === null) loadHistory();
  }

  return (
    <div className="market-signals">
      <PriceBadges property={property} />

      {comps?.median ? (
        <div className="market-comps">
          <span>
            Local sales: <strong>{formatShortGBP(comps.median)}</strong> median
            {vs !== null && (
              <span className={`market-vs ${vsClass(vs)}`}>
                asking {vs > 0 ? "+" : ""}
                {vs.toFixed(0)}%
              </span>
            )}
          </span>
          <small>{compsBasis(comps)}</small>
          {vs !== null && vs <= -BIG_GAP_PCT && (
            <small className="market-warning">
              Well below similar sales: check condition, lease and size before reading it as a
              bargain.
            </small>
          )}
        </div>
      ) : (
        comps && comps.count === 0 && (
          <div className="market-comps">
            <small>No comparable sales recorded nearby.</small>
          </div>
        )
      )}

      {hasDetail && (
        <button type="button" className="market-toggle" onClick={toggle}>
          {open ? "Hide price details" : "Price history & nearby sales"}
        </button>
      )}

      {open && <CompsDetail property={property} history={history} />}
    </div>
  );
}

export default MarketSignals;
