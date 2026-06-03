import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function DashboardView() {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboardData();
  }, []);

  async function loadDashboardData() {
    setLoading(true);

    const { data, error } = await supabase
      .from("properties")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error loading dashboard data:", error);
    } else {
      setProperties(data || []);
    }

    setLoading(false);
  }

  const totalProperties = properties.length;
  const newMatches = properties.filter((p) => p.status === "new").length;
  const favourites = properties.filter((p) => p.status === "favourite").length;
  const archived = properties.filter((p) => p.status === "archived").length;

  const averagePrice =
    properties.length > 0
      ? Math.round(
          properties.reduce((sum, p) => sum + Number(p.price || 0), 0) /
            properties.length
        )
      : 0;

  const latestProperties = properties.slice(0, 5);

  if (loading) {
    return (
      <section className="card">
        <h2>Loading dashboard...</h2>
      </section>
    );
  }

  return (
    <section className="dashboard-page">
      <div className="section-header">
        <h2>Property Dashboard</h2>
        <p>Overview of your current property search.</p>
      </div>

      <div className="dashboard-grid">
        <div className="stat-card">
          <span>Total Properties</span>
          <strong>{totalProperties}</strong>
        </div>

        <div className="stat-card">
          <span>New Matches</span>
          <strong>{newMatches}</strong>
        </div>

        <div className="stat-card">
          <span>Favourites</span>
          <strong>{favourites}</strong>
        </div>

        <div className="stat-card">
          <span>Archived</span>
          <strong>{archived}</strong>
        </div>

        <div className="stat-card">
          <span>Average Price</span>
          <strong>
            {averagePrice ? `£${averagePrice.toLocaleString()}` : "N/A"}
          </strong>
        </div>
      </div>

      <div className="card">
        <h3>Latest Properties</h3>

        {latestProperties.length === 0 ? (
          <p>No properties found yet.</p>
        ) : (
          <div className="property-list">
            {latestProperties.map((property) => (
              <div className="property-list-item" key={property.listing_id}>
                <div>
                  <strong>
                    {property.price
                      ? `£${Number(property.price).toLocaleString()}`
                      : "Price unavailable"}
                  </strong>
                  <p>{property.address}</p>
                </div>

                <span>{property.status || "new"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default DashboardView;
