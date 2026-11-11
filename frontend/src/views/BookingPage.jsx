import { useEffect, useMemo, useState } from "react";

// Public page an agent opens from the buyer's link (/book/<slug>). No login.
// Shows only free slots; the buyer's contact details are never shown here.

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

function groupByDay(slots) {
  const groups = new Map();
  for (const slot of slots) {
    const key = dayFormatter.format(new Date(slot.start));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(slot);
  }
  return [...groups.entries()].map(([day, daySlots]) => ({ day, slots: daySlots }));
}

const emptyForm = {
  agentName: "",
  agency: "",
  agentEmail: "",
  agentPhone: "",
  propertyAddress: "",
  propertyUrl: "",
  message: "",
  website: "", // honeypot
};

function BookingPage({ slug }) {
  const [state, setState] = useState({ loading: true, error: "", page: null, slots: [] });
  const [kind, setKind] = useState("call");
  const [selectedDay, setSelectedDay] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [done, setDone] = useState(null);

  async function load() {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const response = await fetch(`/api/booking?slug=${encodeURIComponent(slug)}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "This booking page isn't available.");
      setState({ loading: false, error: "", page: body.page, slots: body.slots || [] });
    } catch (error) {
      setState({ loading: false, error: error.message, page: null, slots: [] });
    }
  }

  useEffect(() => {
    load();
  }, [slug]);

  const days = useMemo(() => groupByDay(state.slots), [state.slots]);
  const activeDay = days.find((d) => d.day === selectedDay) || days[0];

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    if (!selectedSlot) {
      setSubmitError("Pick a time first.");
      return;
    }

    setSubmitting(true);
    setSubmitError("");

    try {
      const response = await fetch("/api/booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, slug, kind, startsAt: selectedSlot.start }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (response.status === 409) {
          setSelectedSlot(null);
          await load();
        }
        throw new Error(body.error || "Something went wrong. Please try again.");
      }

      setDone({ kind, start: selectedSlot.start });
    } catch (error) {
      setSubmitError(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (state.loading) {
    return (
      <div className="booking-shell">
        <section className="card">
          <p className="muted">Loading available times…</p>
        </section>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="booking-shell">
        <section className="card">
          <h2>Booking page unavailable</h2>
          <p className="muted">{state.error}</p>
        </section>
      </div>
    );
  }

  const name = state.page.displayName;

  if (done) {
    return (
      <div className="booking-shell">
        <section className="card booking-done">
          <p className="eyebrow">Request sent</p>
          <h2>Thanks, {form.agentName.split(" ")[0]}</h2>
          <p>
            {name} has your request for a {done.kind} on{" "}
            <strong>{longFormatter.format(new Date(done.start))}</strong>. You'll get an
            email with a calendar invite as soon as they confirm.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="booking-shell">
      <header className="booking-header">
        <p className="eyebrow">Book a time</p>
        <h1>{name}</h1>
        <p className="muted">
          {state.page.intro ||
            `${name} is house hunting. Instead of calling at a random time, pick a slot below and they'll confirm it.`}
        </p>
      </header>

      <section className="card">
        <div className="booking-kind" role="radiogroup" aria-label="What would you like to book?">
          <button
            type="button"
            role="radio"
            aria-checked={kind === "call"}
            className={kind === "call" ? "primary" : ""}
            onClick={() => setKind("call")}
          >
            Phone call
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={kind === "viewing"}
            className={kind === "viewing" ? "primary" : ""}
            onClick={() => setKind("viewing")}
          >
            Viewing
          </button>
        </div>

        {days.length === 0 ? (
          <p className="muted">
            No times are free in the next couple of weeks. Please check back later.
          </p>
        ) : (
          <>
            <h3 className="booking-step">1. Pick a day</h3>
            <div className="booking-days">
              {days.map((d) => (
                <button
                  type="button"
                  key={d.day}
                  className={activeDay?.day === d.day ? "primary" : ""}
                  onClick={() => {
                    setSelectedDay(d.day);
                    setSelectedSlot(null);
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
                  key={slot.start}
                  className={selectedSlot?.start === slot.start ? "primary" : ""}
                  onClick={() => setSelectedSlot(slot)}
                >
                  {timeFormatter.format(new Date(slot.start))}
                </button>
              ))}
            </div>

            <h3 className="booking-step">3. Your details</h3>
            <form className="booking-form" onSubmit={submit}>
              <div className="booking-form-grid">
                <label>
                  Your name *
                  <input
                    required
                    maxLength={100}
                    value={form.agentName}
                    onChange={(e) => update("agentName", e.target.value)}
                  />
                </label>
                <label>
                  Agency
                  <input
                    maxLength={100}
                    value={form.agency}
                    onChange={(e) => update("agency", e.target.value)}
                  />
                </label>
                <label>
                  Email *
                  <input
                    required
                    type="email"
                    maxLength={254}
                    value={form.agentEmail}
                    onChange={(e) => update("agentEmail", e.target.value)}
                  />
                </label>
                <label>
                  Phone
                  <input
                    type="tel"
                    maxLength={40}
                    value={form.agentPhone}
                    onChange={(e) => update("agentPhone", e.target.value)}
                  />
                </label>
                <label>
                  Property address{kind === "viewing" ? " *" : ""}
                  <input
                    maxLength={200}
                    value={form.propertyAddress}
                    onChange={(e) => update("propertyAddress", e.target.value)}
                  />
                </label>
                <label>
                  Listing link
                  <input
                    type="url"
                    maxLength={500}
                    placeholder="https://"
                    value={form.propertyUrl}
                    onChange={(e) => update("propertyUrl", e.target.value)}
                  />
                </label>
              </div>

              <label>
                What's it about?
                <textarea
                  rows={3}
                  maxLength={1000}
                  value={form.message}
                  onChange={(e) => update("message", e.target.value)}
                />
              </label>

              {/* Honeypot: hidden from people, filled in by bots. */}
              <input
                className="booking-honeypot"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                value={form.website}
                onChange={(e) => update("website", e.target.value)}
              />

              {submitError && <p className="booking-error">{submitError}</p>}

              <button type="submit" className="primary" disabled={submitting || !selectedSlot}>
                {submitting
                  ? "Sending…"
                  : selectedSlot
                    ? `Request ${kind} · ${longFormatter.format(new Date(selectedSlot.start))}`
                    : "Pick a time above"}
              </button>
            </form>
          </>
        )}
      </section>

      <p className="booking-footer muted">
        Times are UK time. {name}'s phone number is shared with you once they confirm.
      </p>
    </div>
  );
}

export default BookingPage;
