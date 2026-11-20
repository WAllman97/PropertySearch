import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";

// Ask the agent for a viewing when they aren't on PropertySearch (migration
// 023): pick up to three times, we email the agent a link to confirm one,
// suggest another or decline. Shown by ViewingSlots when a home has no
// bookable times.

const whenFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const when = (iso) => whenFormatter.format(new Date(iso));

// "YYYY-MM-DDTHH:mm" for a datetime-local input, n days ahead at hh:00.
function inputValue(daysAhead, hour) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function RequestForm({ property, onSent, onCancel }) {
  const [form, setForm] = useState(() => ({
    agentEmail: "",
    agentName: "",
    times: [inputValue(2, 18), inputValue(3, 18), ""],
    duration: 30,
    phone: (() => {
      try {
        return localStorage.getItem("viewing-phone") || "";
      } catch {
        return "";
      }
    })(),
    message: "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Fill in the agent from the home's notes.
  useEffect(() => {
    let live = true;
    supabase
      .from("property_notes")
      .select("estate_agent, estate_agent_email")
      .eq("property_id", property.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!live || !data) return;
        setForm((f) => ({
          ...f,
          agentEmail: f.agentEmail || data.estate_agent_email || "",
          agentName: f.agentName || data.estate_agent || "",
        }));
      });
    return () => {
      live = false;
    };
  }, [property.id]);

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const setTime = (i) => (event) =>
    setForm({ ...form, times: form.times.map((t, j) => (j === i ? event.target.value : t)) });

  async function submit(event) {
    event.preventDefault();
    setError("");
    const options = form.times.filter(Boolean).map((t) => new Date(t).toISOString());
    if (!options.length) {
      setError("Pick at least one time.");
      return;
    }
    try {
      localStorage.setItem("viewing-phone", form.phone);
    } catch {
      // Private mode: just don't remember it.
    }
    setBusy(true);
    const response = await postAuthed("/api/viewings", {
      action: "request",
      propertyId: property.id,
      agentEmail: form.agentEmail,
      agentName: form.agentName,
      options,
      durationMinutes: Number(form.duration),
      phone: form.phone,
      message: form.message,
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setError(result.error || "Could not send the request");
      return;
    }
    onSent();
  }

  return (
    <form className="viewing-request-form" onSubmit={submit}>
      <p className="viewing-note">
        We email the agent your times. They confirm one with a tap, or suggest another, and it goes in
        your calendar. They see your name, email and phone, and your buying position if you share it
        with agents.
      </p>
      <div className="viewing-request-grid">
        <label>
          Agent's email *
          <input
            type="email"
            required
            maxLength={254}
            placeholder="On the listing, or from their emails"
            value={form.agentEmail}
            onChange={set("agentEmail")}
          />
        </label>
        <label>
          Agent's name or agency
          <input maxLength={100} value={form.agentName} onChange={set("agentName")} />
        </label>
      </div>
      <fieldset className="viewing-request-times">
        <legend>Times that suit you (up to three)</legend>
        {form.times.map((t, i) => (
          <input
            key={i}
            type="datetime-local"
            step={900}
            aria-label={`Time ${i + 1}`}
            value={t}
            onChange={setTime(i)}
          />
        ))}
      </fieldset>
      <div className="viewing-request-grid">
        <label>
          Length
          <select value={form.duration} onChange={set("duration")}>
            {[15, 20, 30, 45, 60].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>
        <label>
          Your phone (for the agent)
          <input type="tel" maxLength={40} value={form.phone} onChange={set("phone")} />
        </label>
      </div>
      <label className="viewing-request-message">
        Message (optional)
        <textarea
          rows={2}
          maxLength={500}
          placeholder="e.g. We're first-time buyers with a mortgage in principle"
          value={form.message}
          onChange={set("message")}
        />
      </label>
      <div className="viewing-request-actions">
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "Sending..." : "Send request"}
        </button>
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p className="booking-error">{error}</p>}
    </form>
  );
}

function ViewingRequest({ property, request, onChanged }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const agent = request?.agent_name || request?.agent_email;

  async function act(body, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError("");
    const response = await postAuthed("/api/viewings", body);
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) setError(result.error || "Something went wrong");
    onChanged();
  }

  const stop = (event) => event.stopPropagation();
  const live = request && ["pending", "proposed"].includes(request.status);
  const upcoming = request?.status === "confirmed" && new Date(request.confirmed_start) > new Date();

  if (live || upcoming) {
    return (
      <div className="viewing-slots viewing-request" onClick={stop}>
        {request.status === "pending" && (
          <div className="viewing-request-status">
            <span>
              <span className="request-chip waiting">Waiting for the agent</span> Sent to {agent}:{" "}
              {request.options.map(when).join(" · ")}
            </span>
            <button
              type="button"
              className="link-button"
              disabled={busy}
              onClick={() => act({ action: "cancel_request", requestId: request.id }, "Withdraw this request? The agent will be told.")}
            >
              Withdraw
            </button>
          </div>
        )}
        {request.status === "proposed" && (
          <div className="viewing-request-status">
            <span>
              <span className="request-chip proposed">New time suggested</span> {agent} suggests{" "}
              <strong>{when(request.proposed_start)}</strong>
              {request.agent_note ? ` · “${request.agent_note}”` : ""}
            </span>
            <span className="viewing-request-buttons">
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => act({ action: "accept_proposal", requestId: request.id })}
              >
                Accept
              </button>
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => act({ action: "cancel_request", requestId: request.id }, "Decline this time? The agent will be told.")}
              >
                Decline
              </button>
            </span>
          </div>
        )}
        {upcoming && (
          <div className="viewing-booked">
            <span>
              <strong>Viewing confirmed</strong> {when(request.confirmed_start)} · {agent}
              {request.agent_note ? ` · “${request.agent_note}”` : ""}
            </span>
            <button
              type="button"
              className="link-button"
              disabled={busy}
              onClick={() => act({ action: "cancel_request", requestId: request.id }, "Cancel this viewing? The agent will be emailed.")}
            >
              Cancel
            </button>
          </div>
        )}
        {error && <p className="booking-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="viewing-slots viewing-request" onClick={stop}>
      {!open ? (
        <div className="viewing-slots-head">
          <span>
            {request?.status === "declined" ? (
              <>
                <span className="request-chip declined">Declined</span> {agent} couldn't do a viewing
                {request.agent_note ? `: “${request.agent_note}”` : "."}
              </>
            ) : (
              <>
                <strong>Request a viewing</strong> · send the agent times that suit you
              </>
            )}
          </span>
          <button type="button" className="link-button" onClick={() => setOpen(true)}>
            {request?.status === "declined" ? "Try other times" : "Request"}
          </button>
        </div>
      ) : (
        <RequestForm
          property={property}
          onSent={() => {
            setOpen(false);
            onChanged();
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  );
}

export default ViewingRequest;
