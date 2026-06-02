import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function HomeView() {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProperties();
  }, []);

  async function loadProperties() {
    const { data, error } = await supabase
      .from("properties")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
    } else {
      setProperties(data || []);
    }

    setLoading(false);
  }

  if (loading) {
    return (
      <section className="card">
        <h2>Loading properties...</h2>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="section-header">
        <h2>Latest Property Matches</h2>
        <p>{properties.length} properties found</p>
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
              <h3>{property.price ? `£${property.price.toLocaleString()}` : "Price unavailable"}</h3>

              <p>{property.address}</p>

              <div className="property-meta">
                <span>{property.source}</span>
              </div>

              <a
                href={property.listing_url}
                target="_blank"
                rel="noreferrer"
              >
                View Listing
              </a>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default HomeView;
