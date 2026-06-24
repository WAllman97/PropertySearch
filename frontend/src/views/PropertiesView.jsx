import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import PropertyScoreEditor from "../components/PropertyScoreEditor";
import CommuteSummary from "../components/CommuteSummary";

function getPropertyAgeDays(property) {
  const dateValue =
    property.date_found ||
    property.created_at ||
    property.uploaded_at;

  if (!dateValue) return null;

  const startDate = new Date(dateValue);
  const today = new Date();

  return Math.max(
    0,
    Math.floor((today - startDate) / (1000 * 60 * 60 * 24))
  );
}

function getAgeClass(days) {
  if (days === null) return "";
  if (days < 14) return "age-new";
  if (days < 60) return "age-medium";
  return "age-old";
}

function PropertiesView() {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedProperty, setSelectedProperty] = useState(null);
  const [showScoreModal, setShowScoreModal] = useState(false);

  useEffect(() => {
    loadProperties();
  }, []);

  async function loadProperties() {
    setLoading(true);

    const { data, error } = await supabase
      .from("properties")
      .select("*")
      .or("status.eq.new,status.is.null")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error loading properties:", error);
    } else {
      setProperties(data || []);
    }

    setLoading(false);
  }

  function updateLocalProperty(updatedProperty) {
    setProperties((current) =>
      current.map((property) =>
        property.id === updatedProperty.id ? updatedProperty : property
      )
    );
  }

  async function updateStatus(listingId, status) {
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

    if (!data || data.length === 0) {
      alert("No rows updated. Check listing_id.");
      return;
    }

    const updatedProperty = data[0];

    if (status === "favourite") {
      setSelectedProperty(updatedProperty);
      setShowScoreModal(true);
    }

    setProperties((current) =>
      current.filter((property) => property.listing_id !== listingId)
    );
  }

  function detectSource(url) {
    if (url.includes("rightmove.co.uk")) return "rightmove";
    if (url.includes("zoopla.co.uk")) return "zoopla";
    if (url.includes("onthemarket.com")) return "onthemarket";
    return "manual";
  }

  async function addManualProperty(event) {
    event.preventDefault();

    const form = event.target;
    const listingUrl = form.listing_url.value.trim();
    const source = detectSource(listingUrl);

    const { data, error } = await supabase
      .from("properties")
      .insert({
        source,
        listing_id: `manual-${Date.now()}`,
        title: form.title.value || `${source} property`,
        address: form.address.value || "Address to update",
        price: form.price.value ? Number(form.price.value) : null,
        bedrooms: form.bedrooms.value ? Number(form.bedrooms.value) : null,
        image_url: form.image_url.value || "",
        listing_url: listingUrl,
        date_found: new Date().toISOString().split("T")[0],
        status: "favourite",
      })
      .select()
      .single();

    if (error) {
      alert(error.message);
      return;
    }

    try {
      await fetch("/api/calculate-property-commute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          property_id: data.id,
        }),
      });
    } catch (err) {
      console.error("Commute calculation failed:", err);
    }

    form.reset();
    setShowAddModal(false);
    await loadProperties();
  }

  if (loading) {
    return (
      <section className="card">
        <p>Loading properties...</p>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="section-header">
        <div>
          <h2>Latest Property Matches</h2>
          <p>{properties.length} active properties found</p>
        </div>

        <button
          type="button"
          className="primary-button"
          onClick={() => setShowAddModal(true)}
        >
          + Add Property
        </button>
      </div>

      {showAddModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="section-header">
              <div>
                <h3>Add Property</h3>
                <p>
                  Paste a property link and manually add the key details to your
                  watchlist.
                </p>
              </div>

              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowAddModal(false)}
              >
                Close
              </button>
            </div>

            <form className="manual-property-form" onSubmit={addManualProperty}>
              <label>
                Property link
                <input
                  name="listing_url"
                  type="url"
                  placeholder="Paste Rightmove / OnTheMarket / Zoopla link"
                  required
                />
              </label>

              <label>
                Main image URL
                <input
                  name="image_url"
                  type="url"
                  placeholder="Paste main image URL"
                />
              </label>

              <label>
                Title
                <input
                  name="title"
                  type="text"
                  placeholder="e.g. 3 bed terraced house"
                />
              </label>

              <label>
                Address / area
                <input
                  name="address"
                  type="text"
                  placeholder="e.g. Battersea, London"
                />
              </label>

              <label>
                Price
                <input name="price" type="number" placeholder="750000" />
              </label>

              <label>
                Bedrooms
                <input name="bedrooms" type="number" placeholder="3" />
              </label>

              <button type="submit" className="primary-button">
                Add to Watchlist
              </button>
            </form>
          </div>
        </div>
      )}

      {showScoreModal && selectedProperty && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="section-header">
              <div>
                <h3>Initial Property Score</h3>
                <p>{selectedProperty.address}</p>
              </div>

              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setShowScoreModal(false);
                  setSelectedProperty(null);
                }}
              >
                Close
              </button>
            </div>

            <PropertyScoreEditor
              property={selectedProperty}
              onUpdate={async () => {
                setShowScoreModal(false);
                setSelectedProperty(null);
                await loadProperties();
              }}
            />
          </div>
        </div>
      )}

      <div className="property-grid">
        {properties.map((property) => {
          const propertyAgeDays = getPropertyAgeDays(property);

          return (
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
                    ? `£${Number(property.price).toLocaleString()}`
                    : "Price unavailable"}
                </h3>

                <p>{property.address}</p>

                <div className="property-score-strip">
                  <span>
                    🏠{" "}
                    {property.overall_score
                      ? `${property.overall_score}/100`
                      : "Not scored"}
                  </span>

                  <span>❤️ {property.score_gut_feel || 0}/10</span>

                  {property.offer_interest && (
                    <span>Offer: {property.offer_interest}</span>
                  )}
                </div>

                <CommuteSummary
                  property={property}
                  onCommuteSaved={updateLocalProperty}
                />

                <div className="property-meta">
                  <span>{property.source}</span>

                  {property.bedrooms && <span>{property.bedrooms} beds</span>}

                  {propertyAgeDays !== null && (
                    <span className={getAgeClass(propertyAgeDays)}>
                      Added{" "}
                      {propertyAgeDays === 0
                        ? "today"
                        : `${propertyAgeDays} days ago`}
                    </span>
                  )}

                  {property.status && <span>{property.status}</span>}
                </div>

                <a href={property.listing_url} target="_blank" rel="noreferrer">
                  View Listing
                </a>

                <div className="property-actions">
                  <button
                    onClick={() =>
                      updateStatus(property.listing_id, "favourite")
                    }
                  >
                    Favourite
                  </button>

                  <button
                    onClick={() => updateStatus(property.listing_id, "ignored")}
                  >
                    Ignore
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default PropertiesView;