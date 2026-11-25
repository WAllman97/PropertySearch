import { useEffect, useState } from "react";
import "./AgentPortal.css";
import { apiUrl } from "../lib/platform";

// /report/<token>: the vendor's view of how their home is doing, from a
// private link their agent sends them. No login: the link is the key
// (api/send-listing.js ?report=, migration 035). Buyers are never named,
// just "Buyer 1", "Buyer 2" in the order they first booked.

const pounds = (n) => `£${Number(n).toLocaleString("en-GB")}`;
const day = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
});
const dayTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const STATUS = {
  available: "For sale",
  under_offer: "Under offer",
  sold_stc: "Sold STC",
  off_market: "Off market",
};
const FEEDBACK_TEXT = {
  not_for_us: "Not for us",
  maybe: "Maybe",
  second_look: "Want a second look",
};

function SellerReportPage({ token }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    fetch(apiUrl(`/api/send-listing?report=${encodeURIComponent(token)}`))
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Couldn't load the report. Please try again.");
        setState({ report: body.report });
      })
      .catch((error) => setState({ error: error.message }));
  }, [token]);

  const { report } = state;
  if (state.loading) {
    return (
      <div className="booking-shell">
        <p className="muted">Loading...</p>
      </div>
    );
  }
  if (!report) {
    return (
      <div className="booking-shell">
        <section className="card request-page-card">
          <p className="booking-error">{state.error}</p>
        </section>
      </div>
    );
  }

  const done = report.viewings.filter((v) => v.done);
  const booked = report.viewings.filter((v) => !v.done);
  const counts = Object.keys(FEEDBACK_TEXT)
    .map((key) => ({ key, n: report.feedback.filter((f) => f.answer === key).length }))
    .filter((c) => c.n);

  return (
    <div className="booking-shell">
      <section className="card request-page-card seller-report">
        {report.imageUrl && <img className="save-link-photo" src={report.imageUrl} alt="" />}
        <p className="eyebrow">Seller report</p>
        <h2>{report.address}</h2>
        <p className="seller-report-sub">
          {report.price ? pounds(report.price) : "Price not set"} · {STATUS[report.status] || "For sale"}
          <span className="muted"> · listed {day.format(new Date(report.listedAt))}</span>
        </p>
        {report.agent.name && (
          <p className="muted">
            Your agent: {report.agent.name}
            {report.agent.agency ? `, ${report.agent.agency}` : ""}
          </p>
        )}

        <ul className="seller-report-stats">
          <li>
            <strong>{done.length}</strong>
            <span>viewing{done.length === 1 ? "" : "s"} done</span>
          </li>
          <li>
            <strong>{booked.length}</strong>
            <span>booked</span>
          </li>
          <li>
            <strong>{report.offers.length}</strong>
            <span>offer{report.offers.length === 1 ? "" : "s"}</span>
          </li>
          <li>
            <strong>{report.matchingBuyers}</strong>
            <span>matching buyer{report.matchingBuyers === 1 ? "" : "s"}</span>
          </li>
        </ul>
        {report.sentTo > 0 && (
          <p className="muted">Sent to {report.sentTo} buyer{report.sentTo === 1 ? "" : "s"} whose search it fits.</p>
        )}

        <h3>Viewings</h3>
        {report.viewings.length ? (
          <ul className="seller-report-list">
            {report.viewings.map((v, i) => (
              <li key={i}>
                <span>{dayTime.format(new Date(v.at))}</span>
                <span>
                  {v.buyer}
                  {v.openHouse ? " · open house" : ""}
                </span>
                <span className="muted">{v.done ? "Done" : "Booked"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No viewings booked yet.</p>
        )}

        <h3>What buyers said</h3>
        {report.feedback.length ? (
          <>
            <p className="seller-report-sub">{counts.map((c) => `${c.n} ${FEEDBACK_TEXT[c.key]}`).join(" · ")}</p>
            <ul className="seller-report-list">
              {report.feedback.map((f, i) => (
                <li key={i}>
                  <span>{day.format(new Date(f.at))}</span>
                  <span>
                    {f.buyer}: <strong>{FEEDBACK_TEXT[f.answer] || f.answer}</strong>
                    {f.note ? ` · "${f.note}"` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">No feedback yet. Buyers are asked how it went after each viewing.</p>
        )}

        <h3>Offers</h3>
        {report.offers.length ? (
          <ul className="seller-report-list">
            {report.offers.map((o, i) => (
              <li key={i}>
                <span>{day.format(new Date(o.at))}</span>
                <strong>{pounds(o.amount)}</strong>
                <span className="muted">{o.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No offers yet.</p>
        )}

        {report.prices.length > 0 && (
          <>
            <h3>Asking price</h3>
            <ul className="seller-report-list">
              {report.prices.map((p, i) => (
                <li key={i}>
                  <span>{day.format(new Date(p.at))}</span>
                  <strong>{pounds(p.price)}</strong>
                  <span className="muted">{i === 0 ? "Listed" : p.price < report.prices[i - 1].price ? "Reduced" : "Changed"}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="muted small seller-report-foot">
          Updated live. Buyers' names and contact details are kept private.
        </p>
      </section>
    </div>
  );
}

export default SellerReportPage;
