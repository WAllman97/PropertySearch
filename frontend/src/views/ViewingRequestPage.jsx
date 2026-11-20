import { useEffect, useState } from "react";
import { apiUrl } from "../lib/platform";
import "./AgentPortal.css";

// /request/<token>: an agent who isn't on PropertySearch answers a buyer's
// viewing request (migration 023). No login: the token is the private link
// from our email. Nothing changes until a button here is pressed, because
// mail scanners open links in emails by themselves.

const whenFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const when = (iso) => whenFormatter.format(new Date(iso));

async function call(body) {
  const response = await fetch(apiUrl("/api/viewings"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Something went wrong");
  return result;
}

function ViewingRequestPage({ token }) {
  const params = new URLSearchParams(window.location.search);
  const [request, setRequest] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [pick, setPick] = useState(() => {
    const n = Number(params.get("pick"));
    return Number.isInteger(n) && n >= 0 && n < 3 ? n : null;
  });
  const [mode, setMode] = useState("confirm"); // confirm | propose | decline
  const [proposed, setProposed] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [stopping] = useState(() => params.get("stop") === "1");

  async function load() {
    try {
      const { request: data } = await call({ action: "request_details", token });
      setRequest(data);
    } catch (e) {
      setLoadError(e.message);
    }
  }

  useEffect(() => {
    load();
    // Runs once for this link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(event) {
    event.preventDefault();
    setError("");
    const body = { action: "respond_request", token, choice: mode, note };
    if (mode === "confirm") {
      if (pick === null) {
        setError("Pick one of the times.");
        return;
      }
      body.option = pick;
    }
    if (mode === "propose") {
      if (!proposed) {
        setError("Pick a date and time.");
        return;
      }
      body.proposedStart = new Date(proposed).toISOString();
    }
    setBusy(true);
    try {
      const result = await call(body);
      setDone(result.status);
      await load();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  async function optOut() {
    setBusy(true);
    try {
      await call({ action: "request_opt_out", token });
      await load();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  if (loadError) {
    return (
      <div className="booking-shell">
        <section className="card">
          <h2>This link isn't valid</h2>
          <p className="muted">{loadError}. If you were sent a viewing request, reply to that email to reach the buyer.</p>
        </section>
      </div>
    );
  }
  if (!request) {
    return (
      <div className="booking-shell">
        <p className="muted">Loading the request...</p>
      </div>
    );
  }

  const p = request.property;
  const open = ["pending", "proposed"].includes(request.status);
  const now = Date.now();

  return (
    <div className="booking-shell request-page">
      <header className="booking-header">
        <p className="eyebrow">Viewing request</p>
        <h1>{p.address}</h1>
        <p className="muted">
          {[p.price ? `£${p.price.toLocaleString("en-GB")}` : "", p.bedrooms ? `${p.bedrooms} bed` : ""]
            .filter(Boolean)
            .join(" · ")}
          {p.listingUrl && (
            <>
              {" · "}
              <a href={p.listingUrl} target="_blank" rel="noreferrer">
                View listing
              </a>
            </>
          )}
        </p>
      </header>

      <section className="card request-buyer">
        <h3>{request.buyerName}</h3>
        <p className="muted">
          {request.buyerPhone && <>{request.buyerPhone} · </>}
          {request.buyerEmail}
        </p>
        {request.position && <p className="request-position">✓ {request.position}</p>}
        {request.message && <p className="request-message">“{request.message}”</p>}
      </section>

      {stopping && !request.optedOut && (
        <section className="card">
          <h3>Stop viewing requests to this address?</h3>
          <p className="muted">Buyers will be asked to contact you directly instead.</p>
          <div className="agent-times-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={optOut}>
              Stop requests
            </button>
          </div>
        </section>
      )}
      {request.optedOut && (
        <section className="card">
          <p className="muted">You won't get more viewing requests through PropertySearch at this address.</p>
        </section>
      )}

      {request.status === "confirmed" && (
        <section className="card request-result confirmed">
          <h3>{done === "confirmed" ? "Confirmed. Thank you." : "This viewing is confirmed"}</h3>
          <p>
            <strong>{when(request.confirmedStart)}</strong>, {request.durationMinutes} minutes. A calendar invite is
            on its way to you and to {request.buyerName}.
          </p>
        </section>
      )}
      {request.status === "declined" && (
        <section className="card request-result">
          <h3>{done === "declined" ? "Done. We've let the buyer know." : "You declined this request"}</h3>
        </section>
      )}
      {request.status === "cancelled" && (
        <section className="card request-result">
          <h3>The buyer withdrew this request</h3>
          <p className="muted">Nothing to do.</p>
        </section>
      )}
      {request.status === "proposed" && done === "proposed" && (
        <section className="card request-result">
          <h3>Sent. We've asked {request.buyerName} about {when(request.proposedStart)}.</h3>
          <p className="muted">You'll get a calendar invite if they accept.</p>
        </section>
      )}

      {open && done !== "proposed" && (
        <form className="card request-respond" onSubmit={submit}>
          {request.status === "proposed" && (
            <p className="muted">
              You suggested {when(request.proposedStart)}; the buyer hasn't answered yet. You can still pick one of their
              times or change your suggestion.
            </p>
          )}
          <div className="booking-kind" role="tablist">
            {[
              ["confirm", "Confirm a time"],
              ["propose", "Suggest another"],
              ["decline", "Can't do it"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={mode === value ? "primary" : ""}
                onClick={() => {
                  setMode(value);
                  setError("");
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "confirm" && (
            <fieldset className="request-options">
              <legend>Times that suit {request.buyerName} ({request.durationMinutes} minutes)</legend>
              {request.options.map((option, i) => {
                const past = new Date(option).getTime() < now;
                return (
                  <label key={option} className={`request-option ${pick === i ? "selected" : ""} ${past ? "past" : ""}`}>
                    <input
                      type="radio"
                      name="pick"
                      disabled={past}
                      checked={pick === i}
                      onChange={() => setPick(i)}
                    />
                    <span>{when(option)}</span>
                    {past && <small>passed</small>}
                  </label>
                );
              })}
            </fieldset>
          )}

          {mode === "propose" && (
            <label className="request-field">
              Your suggested time
              <input type="datetime-local" step={900} value={proposed} onChange={(e) => setProposed(e.target.value)} />
            </label>
          )}

          <label className="request-field">
            {mode === "decline" ? "Reason (optional, shown to the buyer)" : "Note for the buyer (optional)"}
            <textarea
              rows={2}
              maxLength={500}
              placeholder={
                mode === "decline"
                  ? "e.g. Now under offer"
                  : "e.g. Meet outside, parking on the street"
              }
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          <div className="agent-times-actions">
            <button type="submit" className="primary-button" disabled={busy}>
              {busy
                ? "Sending..."
                : mode === "confirm"
                  ? pick === null
                    ? "Confirm"
                    : `Confirm ${when(request.options[pick])}`
                  : mode === "propose"
                    ? "Suggest this time"
                    : "Decline the request"}
            </button>
          </div>
          {error && <p className="booking-error">{error}</p>}
        </form>
      )}

      <section className="card request-pitch">
        <h3>Book viewings without the back-and-forth</h3>
        <p className="muted">
          On PropertySearch you set your viewing hours once, buyers who've saved your listings book themselves in,
          and you see their buying position before they arrive.
        </p>
        <a className="secondary-button" href="/agents">
          See how it works for agents
        </a>
      </section>

      {!request.optedOut && !stopping && (
        <p className="muted agent-auth-foot">
          Don't want requests like this? <a href={`/request/${token}?stop=1`}>Stop them</a>.
        </p>
      )}
    </div>
  );
}

export default ViewingRequestPage;
