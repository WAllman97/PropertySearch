import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function getMonthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getMonthEnd(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatMonthTitle(date) {
  return date.toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
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

function buildCalendarDays(currentMonth) {
  const start = getMonthStart(currentMonth);
  const end = getMonthEnd(currentMonth);

  const startDay = start.getDay() === 0 ? 6 : start.getDay() - 1;
  const days = [];

  const calendarStart = new Date(start);
  calendarStart.setDate(start.getDate() - startDay);

  for (let i = 0; i < 42; i++) {
    const date = new Date(calendarStart);
    date.setDate(calendarStart.getDate() + i);

    days.push({
      date,
      isCurrentMonth: date.getMonth() === currentMonth.getMonth(),
      isToday: isSameDay(date, new Date()),
    });
  }

  return days;
}

function getGoogleCalendarLink(viewing) {
  const property = viewing.properties;
  const start = new Date(viewing.viewing_datetime);
  const end = new Date(start.getTime() + 45 * 60 * 1000);

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

function downloadIcsFile(viewing) {
  const property = viewing.properties;
  const start = new Date(viewing.viewing_datetime);
  const end = new Date(start.getTime() + 45 * 60 * 1000);

  const formatIcsDate = (date) =>
    date.toISOString().replace(/[-:]|\.\d{3}/g, "");

  const escapeIcsText = (value) =>
    String(value || "")
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\n/g, "\\n");

  const title = `Property viewing: ${property?.address || "Property"}`;
  const description = [
    `Estate agent: ${viewing.estate_agent || "Not added"}`,
    `Agent phone: ${viewing.estate_agent_phone || "Not added"}`,
    `Agent email: ${viewing.estate_agent_email || "Not added"}`,
    "",
    `Listing: ${property?.listing_url || ""}`,
  ].join("\n");

  const icsContent = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PropertySearch//Viewing Calendar//EN",
    "BEGIN:VEVENT",
    `UID:${viewing.id}@propertysearch`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${escapeIcsText(title)}`,
    `LOCATION:${escapeIcsText(property?.address || "")}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const blob = new Blob([icsContent], {
    type: "text/calendar;charset=utf-8",
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `property-viewing-${viewing.id}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

function CalendarView() {
  const [viewings, setViewings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingViewing, setEditingViewing] = useState(null);
  const [selectedViewing, setSelectedViewing] = useState(null);
  const [currentMonth, setCurrentMonth] = useState(new Date());

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

  const calendarDays = useMemo(
    () => buildCalendarDays(currentMonth),
    [currentMonth]
  );

  function getViewingsForDate(date) {
    return viewings.filter((viewing) =>
      isSameDay(new Date(viewing.viewing_datetime), date)
    );
  }

  function goToPreviousMonth() {
    setCurrentMonth(
      (current) => new Date(current.getFullYear(), current.getMonth() - 1, 1)
    );
  }

  function goToNextMonth() {
    setCurrentMonth(
      (current) => new Date(current.getFullYear(), current.getMonth() + 1, 1)
    );
  }

  function goToToday() {
    setCurrentMonth(new Date());
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
    setSelectedViewing(null);
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
        <div>
          <h2>Viewing Calendar</h2>
          <p>{viewings.length} scheduled viewings</p>
        </div>

        <div className="property-actions">
          <button type="button" className="secondary-button" onClick={goToToday}>
            Today
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={goToPreviousMonth}
          >
            ←
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={goToNextMonth}
          >
            →
          </button>
        </div>
      </div>

      <div className="calendar-header">
        <h3>{formatMonthTitle(currentMonth)}</h3>
      </div>

      <div className="calendar-weekdays">
        <span>Mon</span>
        <span>Tue</span>
        <span>Wed</span>
        <span>Thu</span>
        <span>Fri</span>
        <span>Sat</span>
        <span>Sun</span>
      </div>

      <div className="calendar-grid">
        {calendarDays.map((day) => {
          const dayViewings = getViewingsForDate(day.date);

          return (
            <div
              className={[
                "calendar-day",
                !day.isCurrentMonth ? "calendar-day-muted" : "",
                day.isToday ? "calendar-day-today" : "",
              ].join(" ")}
              key={day.date.toISOString()}
            >
              <div className="calendar-day-number">{day.date.getDate()}</div>

              <div className="calendar-events">
                {dayViewings.map((viewing) => (
                  <button
                    type="button"
                    className="calendar-event"
                    key={viewing.id}
                    onClick={() => setSelectedViewing(viewing)}
                  >
                    <span>{formatTime(viewing.viewing_datetime)}</span>
                    <strong>{viewing.properties?.address}</strong>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {selectedViewing && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="section-header">
              <div>
                <h3>{formatDateTime(selectedViewing.viewing_datetime)}</h3>
                <p>{selectedViewing.properties?.address}</p>
              </div>

              <button
                type="button"
                className="secondary-button"
                onClick={() => setSelectedViewing(null)}
              >
                Close
              </button>
            </div>

            {selectedViewing.properties?.image_url && (
              <img
                src={selectedViewing.properties.image_url}
                alt={selectedViewing.properties.address}
                className="property-detail-image"
              />
            )}

            <p>
              {selectedViewing.properties?.price
                ? `£${Number(selectedViewing.properties.price).toLocaleString()}`
                : "Price unavailable"}
            </p>

            <p className="muted">
              Agent: {selectedViewing.estate_agent || "Not added"}
            </p>

            {selectedViewing.estate_agent_phone && (
              <p className="muted">Phone: {selectedViewing.estate_agent_phone}</p>
            )}

            {selectedViewing.estate_agent_email && (
              <p className="muted">Email: {selectedViewing.estate_agent_email}</p>
            )}

            <div className="property-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => startEditing(selectedViewing)}
              >
                Edit Viewing
              </button>

              <a
                className="primary-button"
                href={getGoogleCalendarLink(selectedViewing)}
                target="_blank"
                rel="noreferrer"
              >
                Add to Google Calendar
              </a>

              <button
                type="button"
                className="secondary-button"
                onClick={() => downloadIcsFile(selectedViewing)}
              >
                Download .ics
              </button>

              {selectedViewing.properties?.listing_url && (
                <a
                  className="secondary-button"
                  href={selectedViewing.properties.listing_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  View Listing
                </a>
              )}
            </div>
          </div>
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