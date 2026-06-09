import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

const emptyNotes = {
  viewing_datetime: "",
  estate_agent: "",
  estate_agent_email: "",
  estate_agent_phone: "",
  positives: "",
  negatives: "",
  questions: "",
  general_notes: "",
};

function HistoryView() {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedProperty, setSelectedProperty] = useState(null);
  const [notes, setNotes] = useState(emptyNotes);
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesMessage, setNotesMessage] = useState("");

  useEffect(() => {
    loadWatchlist();
  }, []);

  useEffect(() => {
    if (selectedProperty) {
      loadNotes(selectedProperty.id);
    }
  }, [selectedProperty]);

  async function loadWatchlist() {
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
      console.error("Error loading watchlist:", error);
    } else {
      setProperties(data || []);
    }

    setLoading(false);
  }

  async function loadNotes(propertyId) {
    setNotesMessage("");

    const { data, error } = await supabase
      .from("property_notes")
      .select("*")
      .eq("property_id", propertyId)
      .maybeSingle();

    if (error) {
      console.error("Error loading notes:", error);
      setNotes(emptyNotes);
      return;
    }

    setNotes({
      viewing_datetime: data?.viewing_datetime || "",
      estate_agent: data?.estate_agent || "",
      estate_agent_email: data?.estate_agent_email || "",
      estate_agent_phone: data?.estate_agent_phone || "",
      positives: data?.positives || "",
      negatives: data?.negatives || "",
      questions: data?.questions || "",
      general_notes: data?.general_notes || "",
    });
  }

  async function saveNotes() {
    if (!selectedProperty) return;

    setSavingNotes(true);
    setNotesMessage("");

    const { error } = await supabase.from("property_notes").upsert(
      {
        property_id: selectedProperty.id,
        ...notes,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "property_id",
      }
    );

    setSavingNotes(false);

    if (error) {
      console.error("Error saving notes:", error);
      setNotesMessage(error.message);
      return;
    }

    setNotesMessage("Notes saved.");
  }

  async function updateStatus(propertyId, status) {
    const { error } = await supabase
      .from("properties")
      .update({ status })
      .eq("id", propertyId);

    if (error) {
      console.error("Error updating property:", error);
      alert(error.message);
      return;
    }

    if (selectedProperty?.id === propertyId) {
      setSelectedProperty((current) =>
        current ? { ...current, status } : current
      );
    }

    await loadWatchlist();
  }

  function handleNotesChange(event) {
    const { name, value } = event.target;

    setNotes((current) => ({
      ...current,
      [name]: value,
    }));
  }

  function getStatusLabel(status) {
    const labels = {
      favourite: "⭐ Favourite",
      viewing_booked: "📅 Viewing Booked",
      viewed: "👀 Viewed",
      offer_considered: "💷 Offer Considered",
      offer_made: "🤝 Offer Made",
    };

    return labels[status] || status;
  }

  if (selectedProperty) {
    return (
      <section className="card">
        <button
          type="button"
          className="secondary-button"
          onClick={() => setSelectedProperty(null)}
        >
          ← Back to Watchlist
        </button>

        <div className="property-detail-layout">
          {selectedProperty.image_url && (
            <img
              src={selectedProperty.image_url}
              alt={selectedProperty.address}
              className="property-detail-image"
            />
          )}

          <div>
            <h2>
              {selectedProperty.price
                ? `£${Number(selectedProperty.price).toLocaleString()}`
                : "Price unavailable"}
            </h2>

            <p>{selectedProperty.address}</p>

            <div className="property-meta">
              <span>{selectedProperty.source}</span>

              {selectedProperty.bedrooms && (
                <span>{selectedProperty.bedrooms} beds</span>
              )}

              <span className={`status-badge status-${selectedProperty.status}`}>
                {getStatusLabel(selectedProperty.status)}
              </span>
            </div>

            <a
              href={selectedProperty.listing_url}
              target="_blank"
              rel="noreferrer"
            >
              View original listing
            </a>
          </div>
        </div>

        <div className="details-section">
          <h3>Viewing Notes</h3>

          <label>
            Viewing date
            <input
              name="viewing_datetime"
              type="datetime-local"
              value={notes.viewing_datetime}
              onChange={handleNotesChange}
            />
          </label>

          <label>
            Estate agent
            <input
              name="estate_agent"
              type="text"
              value={notes.estate_agent}
              onChange={handleNotesChange}
              placeholder="Agent name / branch"
            />
          </label>

          <label>
            Estate agent email
            <input
              name="estate_agent_email"
              type="email"
              value={notes.estate_agent_email}
              onChange={handleNotesChange}
              placeholder="agent@example.com"
            />
          </label>

          <label>
            Estate agent phone
            <input
              name="estate_agent_phone"
              type="text"
              value={notes.estate_agent_phone}
              onChange={handleNotesChange}
              placeholder="Phone number"
            />
          </label>

          <label>
            Positives
            <textarea
              name="positives"
              value={notes.positives}
              onChange={handleNotesChange}
              placeholder="What stands out positively?"
            />
          </label>

          <label>
            Negatives
            <textarea
              name="negatives"
              value={notes.negatives}
              onChange={handleNotesChange}
              placeholder="What are the concerns?"
            />
          </label>

          <label>
            Questions to ask
            <textarea
              name="questions"
              value={notes.questions}
              onChange={handleNotesChange}
              placeholder="Questions for the agent, seller or surveyor..."
            />
          </label>

          <label>
            General notes
            <textarea
              name="general_notes"
              value={notes.general_notes}
              onChange={handleNotesChange}
              placeholder="Anything else worth remembering?"
            />
          </label>

          <button
            type="button"
            className="primary-button"
            onClick={saveNotes}
            disabled={savingNotes}
          >
            {savingNotes ? "Saving..." : "Save Notes"}
          </button>

          {notesMessage && <p className="form-message">{notesMessage}</p>}
        </div>
      </section>
    );
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
          <div
            className="property-card"
            key={property.id}
            onClick={() => setSelectedProperty(property)}
          >
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

              <div className="property-meta">
                <span>{property.source}</span>

                {property.bedrooms && <span>{property.bedrooms} beds</span>}

                <span className={`status-badge status-${property.status}`}>
                  {getStatusLabel(property.status)}
                </span>
              </div>

              <a
                href={property.listing_url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                View Listing
              </a>

              <div
                className="property-actions"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setSelectedProperty(property)}
                >
                  Open Details
                </button>

                <button
                  disabled={property.status === "viewing_booked"}
                  onClick={() => updateStatus(property.id, "viewing_booked")}
                >
                  Viewing booked
                </button>

                <button
                  disabled={property.status === "viewed"}
                  onClick={() => updateStatus(property.id, "viewed")}
                >
                  Viewed
                </button>

                <button
                  disabled={property.status === "offer_considered"}
                  onClick={() =>
                    updateStatus(property.id, "offer_considered")
                  }
                >
                  Offer considered
                </button>

                <button
                  disabled={property.status === "offer_made"}
                  onClick={() => updateStatus(property.id, "offer_made")}
                >
                  Offer made
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