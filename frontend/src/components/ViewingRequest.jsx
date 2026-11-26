import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";
import { friendlyError } from "../lib/errors";
import { liveSiteUrl } from "../lib/platform";
import { findAgentContact } from "../lib/agentContacts";

// Ask the agent for a viewing when they aren't on ViewPal (migration
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
  // No agent email: the ready message for the buyer to send themselves.
  const [share, setShare] = useState(null); // { url, text, copied? }

  // Fill in the agent from the home's notes.
  useEffect(() => {
    let live = true;
    supabase
      .from("property_notes")
      .select("estate_agent, estate_agent_email")
      .eq("property_id", property.id)
      .maybeSingle()
      .then(async ({ data }) => {
        if (!live || !data) return;
        // No email for this home yet: the same agent's from another home.
        const known = !data.estate_agent_email && data.estate_agent ? await findAgentContact(data.estate_agent) : null;
        if (!live) return;
        setForm((f) => ({
          ...f,
          agentEmail: f.agentEmail || data.estate_agent_email || known?.email || "",
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
    let response;
    let result;
    try {
      response = await postAuthed("/api/viewings", {
        action: "request",
        propertyId: property.id,
        agentEmail: form.agentEmail,
        agentName: form.agentName,
        options,
        durationMinutes: Number(form.duration),
        phone: form.phone,
        message: form.message,
      });
      result = await response.json().catch(() => ({}));
    } catch (err) {
      // Network dropped: show why instead of a button stuck on "Sending...".
      setError(friendlyError(err));
      return;
    } finally {
      setBusy(false);
    }
    if (!response.ok) {
      setError(result.error || "Could not send the request");
      return;
    }
    if (result.shareText) {
      setShare({ url: result.shareUrl, text: result.shareText });
      return;
    }
    onSent();
  }

  async function shareIt() {
    try {
      if (navigator.share) {
        await navigator.share({ text: share.text });
        return;
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
    copyIt();
  }

  async function copyIt() {
    try {
      await navigator.clipboard.writeText(share.text);
      setShare({ ...share, copied: true });
    } catch {
      setError("Couldn't copy. Press and hold the message to copy it.");
    }
  }

  // Sent without an email: hand it over to the buyer to send.
  if (share) {
    return (
      <div className="viewing-request-form viewing-request-share">
        <p>
          <strong>Your request is ready. Send it to the agent:</strong> paste it into the listing's
          "Email agent" form, or send it by WhatsApp or text. They confirm a time in one tap, and it
          goes in your calendar.
        </p>
        <textarea readOnly rows={6} value={share.text} onFocus={(e) => e.target.select()} />
        <div className="viewing-request-actions">
          <button type="button" className="primary-button" onClick={shareIt}>
            Share
          </button>
          <button type="button" className="secondary-button" onClick={copyIt}>
            {share.copied ? "Copied" : "Copy message"}
          </button>
          {property.listing_url && (
            <a className="link-button" href={property.listing_url} target="_blank" rel="noreferrer">
              Open the listing
            </a>
          )}
          <button type="button" className="link-button" onClick={onSent}>
            Done
          </button>
        </div>
        {error && <p className="booking-error">{error}</p>}
      </div>
    );
  }

  return (
    <form className="viewing-request-form" onSubmit={submit}>
      <p className="viewing-note">
        The agent gets your times and confirms one with a tap, or suggests another, and it goes in your
        calendar. They see your name, email and phone, and your buying position if you share it with
        agents.
      </p>
      <div className="viewing-request-grid">
        <label>
          Agent's email (if you have it)
          <input
            type="email"
            maxLength={254}
            placeholder="Leave blank and we'll give you a message to send"
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
          <input type="tel" autoComplete="tel" maxLength={40} value={form.phone} onChange={set("phone")} />
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
          {busy ? "Sending..." : form.agentEmail.trim() ? "Send request" : "Create request"}
        </button>
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p className="booking-error">{error}</p>}
    </form>
  );
}

// Invite the home's agent to ViewPal (migration 034): they get a
// single-use link for a 14-day free trial, and once they join the buyer can
// book their times straight in. With no email for the agent, the buyer gets
// the link to send themselves.
function InviteAgent({ property, request }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: request?.agent_email || "", name: request?.agent_name || "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(""); // what to say once it's sent
  const [share, setShare] = useState(null); // { text, copied? }
  const [fallback, setFallback] = useState(null); // the link to share when our email failed

  // Fill in the agent from the home's notes, like the request form.
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    supabase
      .from("property_notes")
      .select("estate_agent, estate_agent_email")
      .eq("property_id", property.id)
      .maybeSingle()
      .then(async ({ data }) => {
        if (!live || !data) return;
        const known = !data.estate_agent_email && data.estate_agent ? await findAgentContact(data.estate_agent) : null;
        if (!live) return;
        setForm((f) => ({
          email: f.email || data.estate_agent_email || known?.email || "",
          name: f.name || data.estate_agent || "",
        }));
      });
    return () => {
      live = false;
    };
  }, [open, property.id]);

  async function send(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setFallback(null);
    try {
      const response = await postAuthed("/api/agent-signup", {
        action: "send_invite",
        propertyId: property.id,
        agentEmail: form.email,
        agentName: form.name,
        viewingRequestId: request?.id,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(result.error || "Could not send the invite");
      } else if (form.email.trim() && result.emailed === false) {
        // Our email didn't go: say so, rather than "Invite sent".
        setError("Couldn't send the invite. Try again, or share the link yourself.");
        setFallback(result.shareText ? { text: result.shareText } : null);
      } else if (result.shareText) {
        setShare({ text: result.shareText });
      } else if (result.already) {
        setDone("You've already invited this agent. Their link lasts 30 days.");
      } else {
        setDone("Invite sent. Once they join, you can book their times straight in.");
      }
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function shareIt() {
    try {
      if (navigator.share) {
        await navigator.share({ text: share.text });
        return;
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(share.text);
      setShare({ ...share, copied: true });
    } catch {
      setError("Couldn't copy. Press and hold the message to copy it.");
    }
  }

  if (done) return <p className="viewing-note">{done}</p>;

  if (share) {
    return (
      <div className="viewing-request-form viewing-request-share">
        <p>
          <strong>Your invite is ready.</strong> Send it to the agent by WhatsApp, text or the listing's contact form.
        </p>
        <textarea readOnly rows={5} value={share.text} onFocus={(e) => e.target.select()} />
        <div className="viewing-request-actions">
          <button type="button" className="primary-button" onClick={shareIt}>
            {share.copied ? "Copied" : "Share"}
          </button>
          <button type="button" className="link-button" onClick={() => setDone("Invite ready. Once they join, you can book their times straight in.")}>
            Done
          </button>
        </div>
        {error && <p className="booking-error">{error}</p>}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="viewing-slots-head">
        <span className="viewing-note">Want to book this agent in one tap next time?</span>
        <button type="button" className="link-button" onClick={() => setOpen(true)}>
          Invite this agent to ViewPal
        </button>
      </div>
    );
  }

  return (
    <form className="viewing-request-form" onSubmit={send}>
      <p className="viewing-note">
        We'll email the agent a free 14-day trial, from ViewPal, mentioning your first name and this home.
      </p>
      <div className="viewing-request-grid">
        <label>
          Agent's email (if you have it)
          <input
            type="email"
            maxLength={254}
            placeholder="Leave blank and we'll give you a link to send"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label>
          Agent's name or agency
          <input maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
      </div>
      <div className="viewing-request-actions">
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "Sending..." : form.email.trim() ? "Send invite" : "Create invite link"}
        </button>
        <button type="button" className="link-button" onClick={() => setOpen(false)}>
          Cancel
        </button>
        {fallback && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setError("");
              setShare(fallback);
            }}
          >
            Share the link instead
          </button>
        )}
      </div>
      {error && <p className="booking-error">{error}</p>}
    </form>
  );
}

function ViewingRequest({ property, request, onChanged }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const agent = request?.agent_name || request?.agent_email || "the agent";

  async function act(body, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError("");
    try {
      const response = await postAuthed("/api/viewings", body);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) setError(result.error || "Something went wrong");
      onChanged();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
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
            {/* Sent by the buyer themselves: let them send the link again. */}
            {!request.agent_email && request.token && (
              <button
                type="button"
                className="link-button"
                onClick={async () => {
                  const text = `I'd like to view ${property.address}. You can confirm a time in one tap here: ${liveSiteUrl}/request/${request.token}`;
                  try {
                    if (navigator.share) await navigator.share({ text });
                    else await navigator.clipboard.writeText(text);
                  } catch {
                    // Cancelled the share sheet: nothing to do.
                  }
                }}
              >
                Send again
              </button>
            )}
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
        <InviteAgent property={property} request={request} />
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
          <button type="button" className="primary-button viewing-request-button" onClick={() => setOpen(true)}>
            {request?.status === "declined" ? "Try other times" : "Request times"}
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
      {!open && <InviteAgent property={property} request={request} />}
    </div>
  );
}

export default ViewingRequest;
