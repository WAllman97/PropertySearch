import { useEffect, useState } from "react";
import "./AgentPortal.css";
import { apiUrl } from "../lib/platform";

// /suggested/<token>: the agent couldn't do the buyer's times and suggested
// another. The buyer accepts or declines straight from the email, no login
// (api/_lib/viewing-requests.js proposal_details / proposal_answer).

const longFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

async function call(body) {
  const response = await fetch(apiUrl("/api/viewings"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || "Something went wrong. Please try again."), data);
  return data;
}

function SuggestedTimePage({ token }) {
  const [state, setState] = useState({ loading: true });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // "confirmed" | "cancelled"

  useEffect(() => {
    call({ action: "proposal_details", token })
      .then((data) => setState({ request: data.request }))
      .catch((error) => setState({ error: error.message }));
  }, [token]);

  async function answer(accept) {
    setBusy(true);
    try {
      const result = await call({ action: "proposal_answer", token, accept });
      setDone(result.status);
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
    }
    setBusy(false);
  }

  const r = state.request;
  const time = r?.proposedStart || r?.confirmedStart;

  return (
    <div className="booking-shell">
      <section className="card offer-page">
        {state.loading && <p className="muted">Loading...</p>}
        {!state.loading && !r && <p className="booking-error">{state.error}</p>}

        {r && (
          <>
            {r.property.imageUrl && <img className="save-link-photo" src={r.property.imageUrl} alt="" />}
            <p className="eyebrow">Viewing</p>
            <h2>{r.property.address}</h2>

            {done === "confirmed" || (!done && r.status === "confirmed") ? (
              <div className="offer-page-done" role="status">
                <p>
                  ✅ Booked for <strong>{longFormatter.format(new Date(time))}</strong>. The agent has been
                  told, it's in your ViewPal calendar, and a calendar invite is on its way.
                </p>
              </div>
            ) : done === "cancelled" || ["cancelled", "declined"].includes(r.status) ? (
              <p className="muted">
                {done ? "No problem. The agent has been told you can't make it." : "This request is closed."} You
                can ask for another time from the home in ViewPal.
              </p>
            ) : (
              <>
                <p>
                  {r.agentName} can't do your times, but suggests
                </p>
                <p className="offer-page-amount">{longFormatter.format(new Date(r.proposedStart))}</p>
                {r.agentNote && <p className="request-message">“{r.agentNote}”</p>}
                {state.error && <p className="booking-error">{state.error}</p>}
                <div className="offer-page-actions">
                  <button type="button" className="primary-button" disabled={busy} onClick={() => answer(true)}>
                    {busy ? "Saving..." : "Book it"}
                  </button>
                  <button type="button" className="secondary-button" disabled={busy} onClick={() => answer(false)}>
                    I can't make it
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}

export default SuggestedTimePage;
