import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function HomeView() {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProperties();
  }, []);

  async function loadProperties() {
    setLoading(true);

    const { data, error } = await supabase
      .from("properties")
      .select("*")
      .not("status", "in", '("ignored","archived","favourite")')
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error loading properties:", error);
    } else {
      setProperties(data || []);
    }

    setLoading(false);
  }

    async function updateStatus(listingId, status) {
      console.log("Updating listing:", listingId, status);

      const { data, error } = await supabase
        .from("properties")
        .update({ status })
        .eq("listing_id", listingId)
        .select();

      if (error) {
        console.error("Error updating property:", error);
        alert(error.message);
        return;
      }

      console.log("Updated rows:", data);

      if (!data || data.length === 0) {
        alert("No rows updated. Check listing_id.");
        return;
      }

      await loadProperties();
    }

  return (
    <section className="card">
      <div className="section-header">
        <h2>Latest Property Matches</h2>
        <p>{properties.length} active properties found</p>
      </div>

      <div className="property-grid">
        {properties.map((property) => (
          <div className="property-card" key={property.id}>
            {property.image_url && (
              <img
                src={property.image_url}
                alt={property.address}
                className="property-image"
              />
            )}

            <div className="property-content">
              <h3>
                {property.price
                  ? `£${property.price.toLocaleString()}`
                  : "Price unavailable"}
              </h3>

              <p>{property.address}</p>

              <div className="property-meta">
                <span>{property.source}</span>
                {property.bedrooms && <span>{property.bedrooms} beds</span>}
                {property.status && <span>{property.status}</span>}
              </div>

              <a href={property.listing_url} target="_blank" rel="noreferrer">
                View Listing
              </a>

              <div className="property-actions">
                <button onClick={() => updateStatus(property.listing_id, "favourite")}>
                  Favourite
                </button>
                <button onClick={() => updateStatus(property.listing_id, "ignored")}>
                  Ignore
                </button>
                <button onClick={() => updateStatus(property.listing_id, "archived")}>
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

export default HomeView;
