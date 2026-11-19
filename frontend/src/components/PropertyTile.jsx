import { useEffect, useRef } from "react";

// Compact tile for a list of homes: photo, price and address. Tap it and it
// flips over (and widens to the full row) to show the details passed as
// children; tap the top again to flip it back.

function pounds(price) {
  return price ? `£${Number(price).toLocaleString("en-GB")}` : "Price unavailable";
}

function daysSince(value) {
  if (!value) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000));
}

function badgesFor(property) {
  const badges = [];
  if (property.price && property.initial_price && property.price < property.initial_price) {
    badges.push({ text: "Reduced", kind: "reduced" });
  }
  if (property.listing_status === "sold_stc") badges.push({ text: "Sold STC", kind: "muted" });
  else if (property.listing_status === "under_offer") badges.push({ text: "Under offer", kind: "muted" });
  else if (property.listing_status === "removed") badges.push({ text: "Off market", kind: "muted" });
  const age = daysSince(property.date_found || property.created_at);
  if (age !== null && age <= 2 && !badges.length) badges.push({ text: "New", kind: "new" });
  return badges;
}

function PropertyTile({ property, open, onToggle, children }) {
  const tileRef = useRef(null);
  const badges = badgesFor(property);
  const facts = [
    property.bedrooms ? `${property.bedrooms} bed` : "",
    property.property_type && property.property_type !== "house" ? property.property_type : "",
  ].filter(Boolean);

  // Opening moves the tile onto its own row: keep it in view.
  useEffect(() => {
    if (open) tileRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [open]);

  return (
    <article ref={tileRef} className={`property-tile${open ? " open" : ""}`}>
      <button
        type="button"
        className="tile-front"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${pounds(property.price)}, ${property.address || "property"}. ${open ? "Hide" : "Show"} details`}
      >
        <div className="tile-photo">
          {property.image_url ? (
            <img src={property.image_url} alt="" loading="lazy" />
          ) : (
            <span className="tile-photo-empty" aria-hidden="true">
              🏠
            </span>
          )}
          {badges.length > 0 && (
            <span className="tile-badges">
              {badges.map((b) => (
                <span key={b.text} className={`tile-badge ${b.kind}`}>
                  {b.text}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="tile-caption">
          <strong>{pounds(property.price)}</strong>
          <span className="tile-address">{property.address}</span>
          {facts.length > 0 && <span className="tile-facts">{facts.join(" · ")}</span>}
        </div>
        {open && (
          <span className="tile-close" aria-hidden="true">
            ✕
          </span>
        )}
      </button>

      {open && <div className="tile-back">{children}</div>}
    </article>
  );
}

export default PropertyTile;
