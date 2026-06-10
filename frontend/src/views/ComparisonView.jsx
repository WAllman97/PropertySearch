import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function ComparisonView() {
  const [properties, setProperties] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProperties();
  }, []);

  async function loadProperties() {
    setLoading(true);

    const { data, error } = await supabase
      .from("properties")
      .select("*")
      .in("status", [
        "favourite",
        "viewing_booked",
        "viewed",
        "offer_considered",
        "offer_made",
      ])
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
    } else {
      setProperties(data || []);
    }

    setLoading(false);
  }

  function toggleProperty(id) {
    setSelectedIds((current) => {
      if (current.includes(id)) {
        return current.filter((x) => x !== id);
      }

      if (current.length >= 3) {
        return current;
      }

      return [...current, id];
    });
  }

  const selectedProperties = useMemo(() => {
    return selectedIds
      .map((id) => properties.find((p) => p.id === id))
      .filter(Boolean);
  }, [selectedIds, properties]);

  function formatPrice(price) {
    if (!price) return "—";
    return `£${Number(price).toLocaleString("en-GB")}`;
  }

  function score(value) {
    return value ?? "—";
  }

  const rows = [
    ["Price", (p) => formatPrice(p.price)],
    ["Bedrooms", (p) => p.bedrooms ?? "—"],
    ["Overall score", (p) => score(p.overall_score)],
    ["Location", (p) => score(p.location_score)],
    ["Quality", (p) => score(p.quality_score)],
    ["Commute", (p) => score(p.commute_score)],
    ["Value", (p) => score(p.value_score)],
    ["Future fit", (p) => score(p.future_fit_score)],
    ["Gut feel", (p) => score(p.gut_feel)],
    ["Offer interest", (p) => score(p.offer_interest)],
  ];

  if (loading) {
    return <div className="page-card">Loading comparison...</div>;
  }

  return (
    <div className="comparison-view">
      <div className="page-header">
        <div>
          <h1>Property Comparison</h1>
          <p>Compare up to three shortlisted properties side by side.</p>
        </div>
      </div>

      <div className="page-card">
        <h2>Select properties</h2>
        <p className="muted-text">
          Choose 2–3 favourites, viewed properties, or offer candidates.
        </p>

        <div className="comparison-selector">
          {properties.map((property) => {
            const selected = selectedIds.includes(property.id);

            return (
              <button
                key={property.id}
                className={`property-select-card ${selected ? "selected" : ""}`}
                onClick={() => toggleProperty(property.id)}
              >
                <strong>{property.address || property.title || "Untitled property"}</strong>
                <span>
                  {formatPrice(property.price)} · {property.bedrooms ?? "—"} beds
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {selectedProperties.length > 0 && (
        <div className="comparison-table-card">
          <table className="comparison-table">
            <thead>
              <tr>
                <th>Metric</th>
                {selectedProperties.map((property) => (
                  <th key={property.id}>
                    <div className="comparison-property-title">
                      {property.address || property.title || "Property"}
                    </div>
                    {property.listing_url && (
                      <a
                        href={property.listing_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open listing
                      </a>
                    )}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {rows.map(([label, getValue]) => (
                <tr key={label}>
                  <td>{label}</td>
                  {selectedProperties.map((property) => (
                    <td key={property.id}>{getValue(property)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedProperties.length === 0 && (
        <div className="empty-state">
          Select at least two properties to start comparing.
        </div>
      )}
    </div>
  );
}

export default ComparisonView;