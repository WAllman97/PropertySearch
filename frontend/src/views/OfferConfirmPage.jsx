import { useEffect, useState } from "react";
import "./AgentPortal.css";
import { apiUrl } from "../lib/platform";

// /offer/<token>: the agent answers "a buyer says you've accepted their
// offer" straight from the email. No login: the private link is the key
// (api/offers.js offer_details / offer_answer, migration 027).

const pounds = (n) => `£${Number(n).toLocaleString("en-GB")}`;

async function call(body) {
  const response = await fetch(apiUrl("/api/offers"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

function OfferConfirmPage({ token }) {
  const [state, setState] = useState({ loading: true });
  const [underOffer, setUnderOffer] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    call({ action: "offer_details", token })
      .then((data) => setState({ offer: data.offer }))
      .catch((error) => setState({ error: error.message }));
  }, [token]);

  async function answer(confirm) {
    setBusy(true);
    try {
      const result = await call({ action: "offer_answer", token, confirm, underOffer: confirm && underOffer });
      setDone({ confirm, underOffer: result.underOffer });
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
    }
    setBusy(false);
  }

  const { offer } = state;

  return (
    <div className="booking-shell">
      <section className="card request-page-card offer-page">
        {state.loading && <p className="muted">Loading...</p>}
        {!state.loading && !offer && <p className="booking-error">{state.error}</p>}

        {offer && (
          <>
            {offer.imageUrl && <img className="save-link-photo" src={offer.imageUrl} alt="" />}
            <p className="eyebrow">Accepted offer</p>
            <h2>{offer.address}</h2>
            <p className="offer-page-amount">{pounds(offer.amount)}</p>
            <p className="muted">{offer.buyerName} says you've accepted their offer.</p>

            {done ? (
              <div className="offer-page-done" role="status">
                {done.confirm ? (
                  <p>
                    ✅ Confirmed. The buyer has been told.
                    {done.underOffer ? " The home is now Under offer, and buyers who saved it have been updated." : ""}
                  </p>
                ) : (
                  <p>Thanks. The buyer has been told it isn't right, so they can check with you.</p>
                )}
              </div>
            ) : offer.status === "withdrawn" ? (
              <p className="muted">The buyer has since withdrawn this offer, so there's nothing to do.</p>
            ) : (
              <>
                {offer.status !== "awaiting_agent" && (
                  <p className="muted">
                    You answered already ({offer.status === "confirmed" ? "confirmed" : "not right"}). You
                    can change it below.
                  </p>
                )}
                {state.error && <p className="booking-error">{state.error}</p>}
                {offer.marketStatus === "available" && (
                  <label className="agent-auto">
                    <input type="checkbox" checked={underOffer} onChange={(e) => setUnderOffer(e.target.checked)} />
                    Also mark the home Under offer
                  </label>
                )}
                <div className="offer-page-actions">
                  <button type="button" className="primary-button" disabled={busy} onClick={() => answer(true)}>
                    {busy ? "Saving..." : "Yes, that's right"}
                  </button>
                  <button type="button" className="secondary-button" disabled={busy} onClick={() => answer(false)}>
                    No, that's not right
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

export default OfferConfirmPage;
