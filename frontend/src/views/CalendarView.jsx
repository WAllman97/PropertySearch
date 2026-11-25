import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { fromLocalInputValue, toLocalInputValue } from "../utils/datetime";
import BookingRequests from "../components/BookingRequests";
import LoadError from "../components/LoadError";
import { ViewingChecklist } from "../components/MustHaves";
import ViewingDayCard, { directionsUrl, isViewingDay, useMinuteClock } from "../components/ViewingDayCard";
import { friendlyError } from "../lib/errors";

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

// ---------------------------------------------------------------------------
// Phone layout: an agenda instead of a month grid (tiny squares are no use on
// a phone). "Next up" card with one-tap directions / call / add to calendar,
// a two-week strip to jump to a day, then each day's viewings and calls.

const DAY_MS = 864e5;

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayLabel(date) {
  const today = startOfDay(new Date());
  const diff = Math.round((startOfDay(date) - today) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
}

// "in 3 hours", "in 25 min", "now"
function untilLabel(date) {
  const mins = Math.round((date - Date.now()) / 60000);
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

function pounds(price) {
  return price ? `£${Number(price).toLocaleString("en-GB")}` : "";
}

// One list of everything with a time: viewings and accepted agent calls.
function agendaItems(viewings, calls) {
  return [
    ...viewings.map((v) => ({ kind: "viewing", at: new Date(v.viewing_datetime), viewing: v, id: `v-${v.id}` })),
    ...calls.map((c) => ({ kind: "call", at: new Date(c.starts_at), call: c, id: `c-${c.id}` })),
  ].sort((a, b) => a.at - b.at);
}

// "2 viewings", "1 viewing · 1 call"
function daySummary(items) {
  const viewingCount = items.filter((i) => i.kind === "viewing").length;
  const callCount = items.length - viewingCount;
  return [
    viewingCount ? `${viewingCount} viewing${viewingCount === 1 ? "" : "s"}` : "",
    callCount ? `${callCount} call${callCount === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function AgendaRow({ item, onOpen, showDate = false }) {
  // Past list: the date matters more than "Viewing".
  const sub = (kind) => (showDate ? item.at.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : kind);
  if (item.kind === "call") {
    const c = item.call;
    return (
      <li className="agenda-row agenda-call">
        <div className="agenda-time">
          <strong>{formatTime(c.starts_at)}</strong>
          <span>{sub("Call")}</span>
        </div>
        <div className="agenda-thumb agenda-thumb-icon" aria-hidden="true">
          📞
        </div>
        <div className="agenda-main">
          <strong>
            {c.agent_name}
            {c.agency ? `, ${c.agency}` : ""}
          </strong>
          {c.property_address && <span>About {c.property_address}</span>}
        </div>
      </li>
    );
  }
  const v = item.viewing;
  const p = v.properties || {};
  return (
    <li className="agenda-row">
      <button type="button" className="agenda-row-button" onClick={() => onOpen(v)}>
        <div className="agenda-time">
          <strong>{formatTime(v.viewing_datetime)}</strong>
          <span>{sub("Viewing")}</span>
        </div>
        {p.image_url ? (
          <img className="agenda-thumb" src={p.image_url} alt="" />
        ) : (
          <div className="agenda-thumb agenda-thumb-icon" aria-hidden="true">
            🏠
          </div>
        )}
        <div className="agenda-main">
          <strong>{p.address || "Viewing"}</strong>
          <span>
            {[pounds(p.price), p.bedrooms ? `${p.bedrooms} bed` : "", v.estate_agent].filter(Boolean).join(" · ")}
          </span>
        </div>
        <span className="agenda-chevron" aria-hidden="true">
          ›
        </span>
      </button>
    </li>
  );
}

function CalendarAgenda({ viewings, calls, onOpen, onOpenSettings, now }) {
  const [showPast, setShowPast] = useState(false);
  const todayStart = startOfDay(now);
  const items = agendaItems(viewings, calls);
  // Still "upcoming" until it's an hour past its start.
  const upcoming = items.filter((i) => i.at.getTime() > now.getTime() - 3600000);
  const past = items.filter((i) => i.at.getTime() <= now.getTime() - 3600000).reverse();
  const next = upcoming.find((i) => i.kind === "viewing");

  // Group upcoming by day.
  const days = [];
  for (const item of upcoming) {
    const key = startOfDay(item.at).getTime();
    const last = days[days.length - 1];
    if (last && last.key === key) last.items.push(item);
    else days.push({ key, date: startOfDay(item.at), items: [item] });
  }
  const busyDays = new Set(days.map((d) => d.key));

  // Two-week strip from today.
  const strip = Array.from({ length: 14 }, (_, n) => new Date(todayStart.getTime() + n * DAY_MS));

  function jumpTo(date) {
    const key = startOfDay(date).getTime();
    const target =
      document.getElementById(`agenda-day-${key}`) ||
      // No viewings that day: the next day that has some.
      days.find((d) => d.key >= key) && document.getElementById(`agenda-day-${days.find((d) => d.key >= key).key}`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="agenda">
      <div className="agenda-strip" role="list" aria-label="Next two weeks">
        {strip.map((date) => {
          const key = date.getTime();
          return (
            <button
              type="button"
              role="listitem"
              key={key}
              className={`agenda-strip-day${key === todayStart.getTime() ? " today" : ""}${busyDays.has(key) ? " busy" : ""}`}
              onClick={() => jumpTo(date)}
            >
              <span>{date.toLocaleDateString("en-GB", { weekday: "narrow" })}</span>
              <strong>{date.getDate()}</strong>
              <i aria-hidden="true" />
            </button>
          );
        })}
      </div>

      {next && isViewingDay(next.at, now) ? (
        // The day itself: everything for standing outside the door.
        <ViewingDayCard
          address={next.viewing.properties?.address}
          when={next.viewing.viewing_datetime}
          agent={next.viewing.estate_agent}
          phone={next.viewing.estate_agent_phone}
          householdId={next.viewing.properties?.household_id}
          propertyId={next.viewing.property_id}
          onDetails={() => onOpen(next.viewing)}
        >
          <ViewingChecklist propertyId={next.viewing.property_id} onOpenSettings={onOpenSettings} />
        </ViewingDayCard>
      ) : next && (
        <div className="agenda-next">
          {next.viewing.properties?.image_url && (
            <img className="agenda-next-photo" src={next.viewing.properties.image_url} alt="" />
          )}
          <div className="agenda-next-body">
            <p className="eyebrow">Next up</p>
            <h3>{next.viewing.properties?.address || "Viewing"}</h3>
            <p className="agenda-next-when">
              {dayLabel(next.at)}, {formatTime(next.viewing.viewing_datetime)} · {untilLabel(next.at)}
            </p>
            {next.viewing.estate_agent && <p className="muted">With {next.viewing.estate_agent}</p>}
            <div className="agenda-next-actions">
              {next.viewing.properties?.address && (
                <a className="primary-button" href={directionsUrl(next.viewing.properties.address)} target="_blank" rel="noreferrer">
                  Directions
                </a>
              )}
              {next.viewing.estate_agent_phone && (
                <a className="secondary-button" href={`tel:${next.viewing.estate_agent_phone.replace(/\s+/g, "")}`}>
                  Call
                </a>
              )}
              <button type="button" className="secondary-button" onClick={() => onOpen(next.viewing)}>
                Details
              </button>
            </div>
          </div>
        </div>
      )}

      {days.length === 0 ? (
        <div className="agenda-empty">
          <p className="agenda-empty-icon" aria-hidden="true">
            📅
          </p>
          <p>
            <strong>No viewings booked</strong>
          </p>
          <p className="muted">
            Book one from a home in your Watchlist, or tap "Book a viewing" in an agent's email. It
            shows up here with directions and the agent's number.
          </p>
        </div>
      ) : (
        days.map((day) => (
          <section className="agenda-day" key={day.key} id={`agenda-day-${day.key}`}>
            <h4 className="agenda-day-head">
              {dayLabel(day.date)}
              <span>{daySummary(day.items)}</span>
            </h4>
            <ul className="agenda-list">
              {day.items.map((item) => (
                <AgendaRow key={item.id} item={item} onOpen={onOpen} />
              ))}
            </ul>
          </section>
        ))
      )}

      {past.length > 0 && (
        <section className="agenda-past">
          <button type="button" className="link-button" onClick={() => setShowPast(!showPast)}>
            {showPast ? "Hide past viewings" : `Past viewings (${past.length})`}
          </button>
          {showPast && (
            <ul className="agenda-list">
              {past.map((item) => (
                <AgendaRow key={item.id} item={item} onOpen={onOpen} showDate />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

// Phone-sized screen? (Same breakpoint as the rest of the phone layout.)
function useIsPhone() {
  const query = "(max-width: 760px)";
  const [isPhone, setIsPhone] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return undefined;
    const update = () => setIsPhone(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return isPhone;
}

// "Add to calendar": on an iPhone the share sheet can hand the invite to the
// Calendar app; elsewhere it downloads the .ics file.
async function addToCalendar(viewing) {
  const file = buildIcsFile(viewing);
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name });
      return;
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
  }
  downloadIcsFile(viewing);
}

function buildIcsFile(viewing) {
  const property = viewing.properties;
  const start = new Date(viewing.viewing_datetime);
  const end = new Date(start.getTime() + 45 * 60 * 1000);
  const fmt = (date) => date.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const esc = (value) =>
    String(value || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const content = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ViewPal//Viewing Calendar//EN",
    "BEGIN:VEVENT",
    `UID:${viewing.id}@viewpal.app`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(`Viewing: ${property?.address || "Property"}`)}`,
    `LOCATION:${esc(property?.address || "")}`,
    `DESCRIPTION:${esc([viewing.estate_agent, viewing.estate_agent_phone].filter(Boolean).join("\n"))}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT1H",
    "ACTION:DISPLAY",
    "DESCRIPTION:Viewing in an hour",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  return new File([content], "viewing.ics", { type: "text/calendar" });
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
    "PRODID:-//ViewPal//Viewing Calendar//EN",
    "BEGIN:VEVENT",
    `UID:${viewing.id}@viewpal.app`,
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

function CalendarView({ onOpenNotes, onOpenSettings }) {
  const [viewings, setViewings] = useState([]);
  const [bookingRequests, setBookingRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [editingViewing, setEditingViewing] = useState(null);
  const [selectedViewing, setSelectedViewing] = useState(null);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [editError, setEditError] = useState("");
  const isPhone = useIsPhone();
  const now = useMinuteClock();

  useEffect(() => {
    loadViewings();
    loadBookingRequests();
  }, []);

  async function loadBookingRequests() {
    // Table only exists once migration 004 has run; treat errors as "none".
    const { data, error } = await supabase
      .from("booking_requests")
      .select("*")
      .in("status", ["pending", "accepted"])
      .order("starts_at", { ascending: true });

    if (error) {
      console.error("Error loading booking requests:", error);
      setBookingRequests([]);
    } else {
      setBookingRequests(data || []);
    }
  }

  async function refreshAll() {
    await Promise.all([loadViewings({ quiet: true }), loadBookingRequests()]);
  }

  async function loadViewings({ quiet = false } = {}) {
    if (!quiet) setLoading(true);

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
          status,
          household_id
        )
      `)
      .not("viewing_datetime", "is", null)
      .order("viewing_datetime", { ascending: true });

    if (error) {
      console.error("Error loading viewings:", error);
      setLoadError(error);
    } else {
      setLoadError(null);
      setViewings(data || []);
    }

    setLoading(false);
  }

  const calendarDays = useMemo(
    () => buildCalendarDays(currentMonth),
    [currentMonth]
  );

  // Accepted calls show on the grid too (accepted viewings already appear
  // via property_notes).
  function getCallsForDate(date) {
    return bookingRequests.filter(
      (r) =>
        r.status === "accepted" &&
        r.kind === "call" &&
        isSameDay(new Date(r.starts_at), date)
    );
  }

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
    setEditError("");
    setEditingViewing({
      id: viewing.id,
      viewing_datetime: toLocalInputValue(viewing.viewing_datetime),
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
        viewing_datetime: fromLocalInputValue(editingViewing.viewing_datetime),
        estate_agent: editingViewing.estate_agent,
        estate_agent_email: editingViewing.estate_agent_email,
        estate_agent_phone: editingViewing.estate_agent_phone,
        updated_at: new Date().toISOString(),
      })
      .eq("id", editingViewing.id);

    if (error) {
      setEditError(friendlyError(error));
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

  if (loadError) return <LoadError error={loadError} onRetry={() => loadViewings()} />;

  const acceptedCalls = bookingRequests.filter((r) => r.status === "accepted" && r.kind === "call");
  const upcomingCount = viewings.filter((v) => new Date(v.viewing_datetime) > new Date()).length;
  // A computer has no "Next up" card: today's viewing goes above the month.
  const todayViewing = viewings.find((v) => isViewingDay(v.viewing_datetime, now));

  return (
    <section className={`card${isPhone ? " calendar-phone" : ""}`}>
      <div className="section-header">
        <div>
          <h2>{isPhone ? "Viewings" : "Viewing Calendar"}</h2>
          <p>
            {upcomingCount
              ? `${upcomingCount} coming up`
              : "Nothing booked yet"}
          </p>
        </div>

        {!isPhone && (
        <div className="property-actions">
          <button type="button" className="secondary-button" onClick={goToToday}>
            Today
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={goToPreviousMonth}
            aria-label="Previous month"
          >
            ←
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={goToNextMonth}
            aria-label="Next month"
          >
            →
          </button>
        </div>
        )}
      </div>

      <BookingRequests requests={bookingRequests} onChanged={refreshAll} />

      {isPhone ? (
        <CalendarAgenda
          viewings={viewings}
          calls={acceptedCalls}
          onOpen={setSelectedViewing}
          onOpenSettings={onOpenSettings}
          now={now}
        />
      ) : (
      <>
      {todayViewing && (
        <ViewingDayCard
          address={todayViewing.properties?.address}
          when={todayViewing.viewing_datetime}
          agent={todayViewing.estate_agent}
          phone={todayViewing.estate_agent_phone}
          householdId={todayViewing.properties?.household_id}
          propertyId={todayViewing.property_id}
          onDetails={() => setSelectedViewing(todayViewing)}
        >
          <ViewingChecklist propertyId={todayViewing.property_id} onOpenSettings={onOpenSettings} />
        </ViewingDayCard>
      )}

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

      {/* Phone only (CSS): the grid becomes an agenda of days with something
          on, so say so when the month has nothing. */}
      {!calendarDays.some(
        (day) =>
          day.isCurrentMonth &&
          (getViewingsForDate(day.date).length || getCallsForDate(day.date).length)
      ) && (
        <p className="calendar-empty-month">
          Nothing booked in {formatMonthTitle(currentMonth)}.
        </p>
      )}

      <div className="calendar-grid">
        {calendarDays.map((day) => {
          const dayViewings = getViewingsForDate(day.date);
          const dayCalls = getCallsForDate(day.date);

          return (
            <div
              className={[
                "calendar-day",
                !day.isCurrentMonth ? "calendar-day-muted" : "",
                day.isToday ? "calendar-day-today" : "",
                dayViewings.length || dayCalls.length ? "has-events" : "",
              ].join(" ")}
              key={day.date.toISOString()}
            >
              <div className="calendar-day-number">
                <span className="calendar-day-name">
                  {day.date.toLocaleDateString("en-GB", { weekday: "short" })}{" "}
                </span>
                {day.date.getDate()}
                {day.isToday && <span className="calendar-day-name"> · Today</span>}
              </div>

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
                {dayCalls.map((call) => (
                  <div className="calendar-event calendar-event-call" key={call.id}>
                    <span>{formatTime(call.starts_at)}</span>
                    <strong>
                      Call: {call.agent_name}
                      {call.agency ? `, ${call.agency}` : ""}
                    </strong>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      </>
      )}

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

            <div className="property-actions viewing-detail-actions">
              {selectedViewing.properties?.address && (
                <a
                  className="primary-button"
                  href={directionsUrl(selectedViewing.properties.address)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Directions
                </a>
              )}

              {selectedViewing.estate_agent_phone && (
                <a
                  className="secondary-button"
                  href={`tel:${selectedViewing.estate_agent_phone.replace(/\s+/g, "")}`}
                >
                  Call agent
                </a>
              )}

              <button
                type="button"
                className="secondary-button"
                onClick={() => addToCalendar(selectedViewing)}
              >
                Add to calendar
              </button>

              <a
                className="secondary-button"
                href={getGoogleCalendarLink(selectedViewing)}
                target="_blank"
                rel="noreferrer"
              >
                Google Calendar
              </a>

              <button
                type="button"
                className="secondary-button"
                onClick={() => startEditing(selectedViewing)}
              >
                Edit
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

            {selectedViewing.property_id && (
              <div className="viewing-modal-checklist">
                <ViewingChecklist
                  propertyId={selectedViewing.property_id}
                  onOpenSettings={onOpenSettings}
                />
                {onOpenNotes && (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => onOpenNotes(selectedViewing.property_id)}
                  >
                    Notes &amp; scoring →
                  </button>
                )}
              </div>
            )}
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
                  type="tel"
                  autoComplete="tel"
                  value={editingViewing.estate_agent_phone}
                  onChange={handleEditChange}
                />
              </label>

              <button type="submit" className="primary-button">
                Save Changes
              </button>
              {editError && (
                <p className="form-error" role="alert">
                  {editError}
                </p>
              )}
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

export default CalendarView;