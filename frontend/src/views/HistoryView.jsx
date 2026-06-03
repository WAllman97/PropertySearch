import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function HistoryView() {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadWatchlist();
  }, []);

  async function loadWatchlist() {
    setLoading(true);

    const { data, error } = await supabase
      .from("properties")
      .select("*")
      .in("status", ["favourite", "viewing_booked", "viewed", "offer_considered", "offer_made"])
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
    } else {
      setProperties(data || []);
    }

    setLoading(false);
  }

  async function updateStatus(propertyId, status) {
    const { error } = await supabase
      .from("properties")
      .update({ status })
      .eq("id", propertyId);

    if (!error) {
      loadWatchlist();
    }
  }

  if (loading) {
    return (
      <section className="card">
        <h2>Loading watchlist...</h2>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="section-header">
        <h2>Watchlist</h2>
        <p>{properties.length} tracked properties</p>
      </div>

      <div className="property-grid">
        {properties.map((property) => (
          <div className="property-card" key={property.id}>
            {property.image_url && (
              <img src={property.image_url} alt={property.address} className="property-image" />
            )}

            <div className="property-content">
              <h3>{property.price ? `£${property.price.toLocaleString()}` : "Price unavailable"}</h3>
              <p>{property.address}</p>

              <div className="property-meta">
                <span>{property.source}</span>
                {property.bedrooms && <span>{property.bedrooms} beds</span>}
                <span>{property.status}</span>
              </div>

              <a href={property.listing_url} target="_blank" rel="noreferrer">
                View Listing
              </a>

              <div className="property-actions">
                <button onClick={() => updateStatus(property.id, "viewing_booked")}>
                  Viewing booked
                </button>
                <button onClick={() => updateStatus(property.id, "viewed")}>
                  Viewed
                </button>
                <button onClick={() => updateStatus(property.id, "offer_considered")}>
                  Offer considered
                </button>
                <button onClick={() => updateStatus(property.id, "archived")}>
                  Archive
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default HistoryView;