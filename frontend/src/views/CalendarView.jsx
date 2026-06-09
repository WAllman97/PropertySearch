import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function CalendarView() {
  const [viewings, setViewings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingViewing, setEditingViewing] = useState(null);

  useEffect(() => {
    loadViewings();
  }, []);

  async function loadViewings() {
    setLoading(true);

    const { data, error } = await supabase
      .from("property_notes")
      .select(`
        *,
        properties (
          id,
          address,
          price,
          bedrooms,
          listing_url,
          image_url,
          status
        )
      `)
      .not("viewing_datetime", "is", null)
      .order("viewing_datetime", { ascending: true });

    if (error) {
      console.error("Error loading viewings:", error);
    } else {
      setViewings(data || []);
    }

    setLoading(false);
  }

  function formatDateTime(value) {
    return new Date(value).toLocaleString("en-GB", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function getCalendarLink(viewing) {
    const property = viewing.properties;
    const start = new Date(viewing.viewing_datetime);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    const formatForGoogle = (date) =>
      date.toISOString().replace(/[-:]|\.\d{3}/g, "");

    const title = encodeURIComponent(
      `Property viewing: ${property?.address || ""}`
    );

    const details = encodeURIComponent(
      [
        `Estate agent: ${viewing.estate_agent || "Not added"}`,
        `Agent phone: ${viewing.estate_agent_phone || "Not added"}`,
        `Agent email: ${viewing.estate_agent_email || "Not added"}`,
        "",
        `Listing: ${property?.listing_url || ""}`,
      ].join("\n")
    );

    const location = encodeURIComponent(property?.address || "");

    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${formatForGoogle(
      start
    )}/${formatForGoogle(end)}&details=${details}&location=${location}`;
  }

  function startEditing(viewing) {
    setEditingViewing({
      id: viewing.id,
      viewing_datetime: viewing.viewing_datetime
        ? viewing.viewing_datetime.slice(0, 16)
        : "",
      estate_agent: viewing.estate_agent || "",
      estate_agent_email: viewing.estate_agent_email || "",
      estate_agent_phone: viewing.estate_agent_phone || "",
    });
  }

  function handleEditChange(event) {
    const { name, value } = event.target;

    setEditingViewing((current) => ({
      ...current,
      [name]: value,
    }));
  }

  async function saveViewingEdit(event) {
    event.preventDefault();

    const { error } = await supabase
      .from("property_notes")
      .update({
        viewing_datetime: editingViewing.viewing_datetime || null,
        estate_agent: editingViewing.estate_agent,
        estate_agent_email: editingViewing.estate_agent_email,
        estate_agent_phone: editingViewing.estate_agent_phone,
        updated_at: new Date().toISOString(),
      })
      .eq("id", editingViewing.id);

    if (error) {
      alert(error.message);
      return;
    }

    setEditingViewing(null);
    await loadViewings();
  }

  if (loading) {
    return (
      <section className="card">
        <h2>Loading viewings...</h2>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="section-header">
        <h2>Viewing Calendar</h2>
        <p>{viewings.length} scheduled viewings</p>
      </div>

      {viewings.length === 0 ? (
        <p>No viewings scheduled yet.</p>
      ) : (
        <div className="viewing-list">
          {viewings.map((viewing) => (
            <div className="viewing-card" key={viewing.id}>
              <div>
                <h3>{formatDateTime(viewing.viewing_datetime)}</h3>

                <p>
                  {viewing.properties?.price
                    ? `£${Number(viewing.properties.price).toLocaleString()}`
                    : "Price unavailable"}
                </p>

                <p>{viewing.properties?.address}</p>

                <p className="muted">
                  Agent: {viewing.estate_agent || "Not added"}
                </p>

                {viewing.estate_agent_phone && (
                  <p className="muted">Phone: {viewing.estate_agent_phone}</p>
                )}
              </div>

              <div className="property-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => startEditing(viewing)}
                >
                  Edit
                </button>

                <a
                  className="primary-button"
                  href={getCalendarLink(viewing)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Add to Google Calendar
                </a>

                {viewing.properties?.listing_url && (
                  <a
                    className="secondary-button"
                    href={viewing.properties.listing_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View Listing
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editingViewing && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="section-header">
              <div>
                <h3>Edit Viewing</h3>
                <p>Update the viewing date, time and agent details.</p>
              </div>

              <button
                type="button"
                className="secondary-button"
                onClick={() => setEditingViewing(null)}
              >
                Close
              </button>
            </div>

            <form className="manual-property-form" onSubmit={saveViewingEdit}>
              <label>
                Viewing date and time
                <input
                  name="viewing_datetime"
                  type="datetime-local"
                  value={editingViewing.viewing_datetime}
                  onChange={handleEditChange}
                />
              </label>

              <label>
                Estate agent
                <input
                  name="estate_agent"
                  type="text"
                  value={editingViewing.estate_agent}
                  onChange={handleEditChange}
                />
              </label>

              <label>
                Estate agent email
                <input
                  name="estate_agent_email"
                  type="email"
                  value={editingViewing.estate_agent_email}
                  onChange={handleEditChange}
                />
              </label>

              <label>
                Estate agent phone
                <input
                  name="estate_agent_phone"
                  type="text"
                  value={editingViewing.estate_agent_phone}
                  onChange={handleEditChange}
                />
              </label>

              <button type="submit" className="primary-button">
                Save Changes
              </button>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

export default CalendarView;