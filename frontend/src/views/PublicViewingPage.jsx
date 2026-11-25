import { useEffect, useMemo, useState } from "react";
import "./AgentPortal.css";
import { apiUrl } from "../lib/platform";
import { friendlyError } from "../lib/errors";

// Public page an agent shares with buyers: /viewings/<listing id>. Anyone can
// book one of the agent's times without an account. ?cancel=<token> shows
// the cancel screen linked from the confirmation email.

const dayFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
});
const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const longFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function CancelBooking({ token }) {
  const [state, setState] = useState({ loading: true });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    fetch(apiUrl(`/api/listing-viewings?cancel=${encodeURIComponent(token)}`))
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) =>
        setState(ok ? { booking: body.booking } : { error: body.error || "Booking not found" })
      )
      // No signal: offer a retry rather than "Loading..." forever.
      .catch((err) => setState({ error: friendlyError(err), retry: true }));
  }, [token, attempt]);

  function retry() {
    setState({ loading: true });
    setAttempt((n) => n + 1);
  }

  async function cancel() {
    setState({ ...state, busy: true, error: "" });
    try {
      const response = await fetch(apiUrl("/api/listing-viewings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", token }),
      });
      const body = await response.json().catch(() => ({}));
      setState(
        response.ok
          ? { booking: { ...state.booking, status: "cancelled" }, justCancelled: true }
          : { ...state, busy: false, error: body.error || "Could not cancel" }
      );
    } catch (err) {
      setState({ ...state, busy: false, error: friendlyError(err) });
    }
  }

  const { booking } = state;

  return (
    <div className="booking-shell">
      <section className="card">
        {state.loading ? (
          <p className="muted">Loading...</p>
        ) : !booking ? (
          <>
            <p className="booking-error">{state.error}</p>
            {state.retry && (
              <button type="button" className="secondary-button" onClick={retry}>
                Try again
              </button>
            )}
          </>
        ) : booking.status === "cancelled" ? (
          <>
            <p className="eyebrow">Cancelled</p>
            <h2>{state.justCancelled ? "Your viewing is cancelled" : "This viewing was cancelled"}</h2>
            <p className="muted">
              {booking.address}, {booking.when}. The agent has been told.
            </p>
          </>
        ) : (
          <>
            <p className="eyebrow">Your viewing</p>
            <h2>{booking.address}</h2>
            <p>{booking.when}</p>
            {booking.past ? (
              <p className="muted">This viewing has already happened.</p>
            ) : (
              <>
                <p className="muted">Can't make it? Cancel so someone else can have the time.</p>
                {state.error && <p className="booking-error">{state.error}</p>}
                <button
                  type="button"
                  className="primary-button"
                  disabled={state.busy}
                  onClick={cancel}
                >
                  {state.busy ? "Cancelling..." : "Cancel my viewing"}
                </button>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function PublicViewingPage({ listingId }) {
  const params = new URLSearchParams(window.location.search);
  const cancelToken = params.get("cancel");
  // From a "new match" email: identifies the buyer, so their details are
  // already filled in (migration 025).
  const buyerToken = params.get("b");
  const [state, setState] = useState({ loading: true });
  const [selectedDay, setSelectedDay] = useState(null);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", website: "" });
  // Known buyer: show "Booking as ..." instead of the form, unless they
  // want to change something or we're missing their phone.
  const [editingDetails, setEditingDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);

  async function load() {
    const query = `listing=${encodeURIComponent(listingId)}${
      buyerToken ? `&b=${encodeURIComponent(buyerToken)}` : ""
    }`;
    let response;
    let body;
    try {
      response = await fetch(apiUrl(`/api/listing-viewings?${query}`));
      body = await response.json().catch(() => ({}));
    } catch (err) {
      // No signal. On first load show a retry instead of "Loading..." forever;
      // if the page is already showing times, keep them on screen.
      setState((current) => (current.listing ? current : { loadFailed: friendlyError(err) }));
      return;
    }
    setState(response.ok ? body : { error: body.error || "This booking link isn't active" });
    if (response.ok && body.buyer) {
      setForm((current) => ({
        ...current,
        name: current.name || body.buyer.name || "",
        email: body.buyer.email || "",
        phone: current.phone || body.buyer.phone || "",
      }));
    }
  }

  useEffect(() => {
    if (!cancelToken) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId]);

  const days = useMemo(() => {
    const groups = new Map();
    for (const slot of state.slots || []) {
      const day = dayFormatter.format(new Date(slot.start));
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(slot);
    }
    return [...groups.entries()].map(([day, slots]) => ({ day, slots }));
  }, [state.slots]);

  if (cancelToken) return <CancelBooking token={cancelToken} />;

  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    let response;
    let body;
    try {
      response = await fetch(apiUrl("/api/listing-viewings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "book",
          listingId,
          slotId: selected.id,
          ...form,
          b: state.buyer ? buyerToken : undefined,
        }),
      });
      body = await response.json().catch(() => ({}));
    } catch (err) {
      // Network dropped: keep their choice so they can just tap Book again.
      setError(friendlyError(err));
      return;
    } finally {
      setBusy(false);
    }
    if (!response.ok) {
      setError(body.error || "Could not book that viewing");
      setSelected(null);
      load();
      return;
    }
    setDone({ slot: selected });
  }

  if (state.loading) {
    return (
      <div className="booking-shell">
        <p className="muted">Loading...</p>
      </div>
    );
  }

  if (state.loadFailed) {
    return (
      <div className="booking-shell">
        <section className="card">
          <p className="booking-error">{state.loadFailed}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setState({ loading: true });
              load();
            }}
          >
            Try again
          </button>
        </section>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="booking-shell">
        <section className="card">
          <h2>Viewing times unavailable</h2>
          <p className="muted">{state.error}. Please contact the agent directly.</p>
        </section>
      </div>
    );
  }

  const { listing } = state;
  const agent = listing.agent || {};
  const agentText = [agent.name, [agent.agency, agent.branch].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  if (done) {
    return (
      <div className="booking-shell">
        <section className="card booking-done">
          <p className="eyebrow">Viewing booked</p>
          <h2>See you there, {form.name.split(" ")[0]}</h2>
          <p>
            <strong>{listing.address}</strong>
            <br />
            {longFormatter.format(new Date(done.slot.start))}
            {done.slot.openHouse ? " (open house)" : ""}
          </p>
          <p className="muted">
            {agentText} has your details. A confirmation with a calendar invite is on its way to{" "}
            {form.email}, with a link to cancel if you can't make it.
            {state.buyer ? " It's in your PropertySearch calendar too." : ""}
          </p>
          {listing.notes && <p className="viewing-note">{listing.notes}</p>}
        </section>
        <p className="booking-footer muted">
          House hunting? <a href="/">PropertySearch</a> tracks listings, price drops and local sold
          prices for you.
        </p>
      </div>
    );
  }

  const activeDay = days.find((d) => d.day === selectedDay) || days[0];
  // We know who they are and have a phone for the agent: one tap to book.
  const knownBuyer = Boolean(state.buyer && form.name && form.phone && !editingDetails);

  return (
    <div className="booking-shell">
      <header className="booking-header">
        <p className="eyebrow">Book a viewing</p>
        <h1>{listing.address}</h1>
        <p className="muted">
          {listing.price ? `£${listing.price.toLocaleString("en-GB")} · ` : ""}
          {agentText}
          {" · "}
          <a href={listing.listingUrl} target="_blank" rel="noreferrer">
            View listing
          </a>
        </p>
        {listing.notes && <p className="viewing-note">{listing.notes}</p>}
      </header>

      <section className="card">
        {listing.closed ? (
          <p className="muted">
            {listing.closed === "sold_stc"
              ? "Sorry, this home is now sold, subject to contract, so it isn't taking viewings."
              : "Sorry, this home has been taken off the market."}{" "}
            Your saved searches will keep sending you new homes that match.
          </p>
        ) : days.length === 0 ? (
          <p className="muted">
            No viewing times are free right now.
            {agent.phone ? ` Call ${agent.phone} to arrange one.` : " Please contact the agent."}
          </p>
        ) : (
          <>
            {error && <p className="booking-error">{error}</p>}
            <h3 className="booking-step">1. Pick a day</h3>
            <div className="booking-days">
              {days.map((d) => (
                <button
                  type="button"
                  key={d.day}
                  className={activeDay?.day === d.day ? "primary" : ""}
                  onClick={() => {
                    setSelectedDay(d.day);
                    setSelected(null);
                  }}
                >
                  {d.day}
                  <span className="booking-count">{d.slots.length}</span>
                </button>
              ))}
            </div>

            <h3 className="booking-step">2. Pick a time</h3>
            <div className="booking-slots">
              {activeDay?.slots.map((slot) => (
                <button
                  type="button"
                  key={slot.id}
                  className={selected?.id === slot.id ? "primary" : ""}
                  onClick={() => setSelected(slot)}
                >
                  {timeFormatter.format(new Date(slot.start))}
                  {slot.openHouse && (
                    <span className="booking-count">open house · {slot.spacesLeft} left</span>
                  )}
                </button>
              ))}
            </div>

            {selected && (
              <>
                <h3 className="booking-step">{knownBuyer ? "3. Confirm" : "3. Your details"}</h3>
                <form className="booking-form" onSubmit={submit}>
                  {knownBuyer ? (
                    <p className="booking-as">
                      Booking as <strong>{form.name}</strong> · {form.email} · {form.phone}{" "}
                      <button type="button" className="link-button" onClick={() => setEditingDetails(true)}>
                        Change
                      </button>
                    </p>
                  ) : (
                  <div className="booking-form-grid">
                    <label>
                      Your name *
                      <input required maxLength={100} value={form.name} onChange={update("name")} />
                    </label>
                    {/* A known buyer books under their account email. */}
                    {!state.buyer && (
                    <label>
                      Email *
                      <input
                        required
                        type="email"
                        maxLength={254}
                        autoComplete="email"
                        value={form.email}
                        onChange={update("email")}
                      />
                    </label>
                    )}
                    <label>
                      Phone *
                      <input
                        required
                        type="tel"
                        maxLength={40}
                        autoComplete="tel"
                        value={form.phone}
                        onChange={update("phone")}
                      />
                    </label>
                  </div>
                  )}
                  <input
                    className="booking-honeypot"
                    tabIndex={-1}
                    autoComplete="off"
                    aria-hidden="true"
                    value={form.website}
                    onChange={update("website")}
                  />
                  <button type="submit" className="primary-button" disabled={busy}>
                    {busy
                      ? "Booking..."
                      : `Book ${dayFormatter.format(new Date(selected.start))}, ${timeFormatter.format(
                          new Date(selected.start)
                        )}`}
                  </button>
                </form>
              </>
            )}
          </>
        )}
      </section>

      <p className="booking-footer muted">
        Your details go only to {agent.agency || "the agent"} for this viewing.
      </p>
    </div>
  );
}

export default PublicViewingPage;
