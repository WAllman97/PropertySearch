import CommuteSummary from "./CommuteSummary";
import TotalCost from "./TotalCost";
import { stageLabel } from "./StagePicker";
import { checklistSummary } from "./MustHaves";

// Two or three saved homes side by side, to settle "which one?". Read-only:
// changes are made on each home's own page (tap its photo). A real table, so
// screen readers can read across a row; on a phone it scrolls sideways with
// the row names pinned on the left.

const pounds = (price) => (price ? `£${Number(price).toLocaleString("en-GB")}` : "–");

const OFFER_TEXT = {
  awaiting_agent: "waiting for the agent",
  confirmed: "confirmed by the agent",
  disputed: "the agent disputes it",
  unverified: "not confirmed",
};

function Tick({ answer }) {
  if (answer === "yes") {
    return (
      <span className="compare-yes" aria-label="Yes">
        ✓
      </span>
    );
  }
  if (answer === "no") {
    return (
      <span className="compare-no" aria-label="No">
        ✗
      </span>
    );
  }
  return (
    <span className="compare-unchecked" aria-label="Not checked">
      –
    </span>
  );
}

function CompareHomes({ homes, mustHaves, checklists, offers, position, onBack, onOpen }) {
  const items = mustHaves || [];
  // The best of each number gets a gentle highlight.
  const best = (values, pick) => {
    const real = values.filter((v) => v != null && !Number.isNaN(v));
    return real.length > 1 ? pick(...real) : null;
  };
  const prices = homes.map((h) => (h.price ? Number(h.price) : null));
  const scores = homes.map((h) => h.overall_score ?? null);
  const guts = homes.map((h) => h.score_gut_feel ?? null);
  const lowestPrice = best(prices, Math.min);
  const topScore = best(scores, Math.max);
  const topGut = best(guts, Math.max);

  return (
    <div className="compare">
      <div className="compare-head">
        <button type="button" className="secondary-button" onClick={onBack}>
          ← Back
        </button>
        <h2>Compare</h2>
      </div>

      <div className="compare-scroll" tabIndex={0} aria-label="Homes side by side">
        <table className="compare-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Home</span>
              </th>
              {homes.map((home) => (
                <th scope="col" key={home.id}>
                  <button type="button" className="compare-photo" onClick={() => onOpen(home)}>
                    {home.image_url ? (
                      <img src={home.image_url} alt="" loading="lazy" />
                    ) : (
                      <span aria-hidden="true">🏠</span>
                    )}
                    <span className="compare-address">{home.address || "Saved home"}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Price</th>
              {homes.map((home, i) => (
                <td key={home.id} className={prices[i] != null && prices[i] === lowestPrice ? "best" : ""}>
                  <strong>{pounds(home.price)}</strong>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Bedrooms</th>
              {homes.map((home) => (
                <td key={home.id}>{home.bedrooms == null ? "–" : home.bedrooms === 0 ? "Studio" : home.bedrooms}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Cost</th>
              {homes.map((home) => (
                <td key={home.id}>
                  {position && home.price ? <TotalCost price={home.price} position={position} /> : "–"}
                </td>
              ))}
            </tr>

            {items.length > 0 && (
              <>
                <tr className="compare-group">
                  <th scope="row">Must-haves</th>
                  {homes.map((home) => {
                    const { yes, total } = checklistSummary(items, checklists[home.id]);
                    return (
                      <td key={home.id}>
                        {yes} of {total}
                      </td>
                    );
                  })}
                </tr>
                {items.map((item) => (
                  <tr key={item.id} className="compare-must-have">
                    <th scope="row">{item.label}</th>
                    {homes.map((home) => (
                      <td key={home.id}>
                        <Tick answer={(checklists[home.id] || {})[item.id]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </>
            )}

            <tr>
              <th scope="row">Score</th>
              {homes.map((home, i) => (
                <td key={home.id} className={scores[i] != null && scores[i] === topScore ? "best" : ""}>
                  {home.overall_score != null ? `${home.overall_score}/100` : "–"}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Gut feel</th>
              {homes.map((home, i) => (
                <td key={home.id} className={guts[i] != null && guts[i] === topGut ? "best" : ""}>
                  {home.score_gut_feel != null ? `${home.score_gut_feel}/10` : "–"}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Commute</th>
              {homes.map((home) => (
                <td key={home.id}>
                  <CommuteSummary property={home} />
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Stage</th>
              {homes.map((home) => (
                <td key={home.id}>{stageLabel(home.status)}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Offer</th>
              {homes.map((home) => {
                const offer = offers[home.id];
                return (
                  <td key={home.id}>
                    {offer ? (
                      <>
                        Accepted at {pounds(offer.amount)}
                        {OFFER_TEXT[offer.status] && <span className="compare-sub">{OFFER_TEXT[offer.status]}</span>}
                      </>
                    ) : home.offer_interest ? (
                      home.offer_interest
                    ) : (
                      "–"
                    )}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="compare-note">Tap a photo to open that home. Costs are estimates.</p>
    </div>
  );
}

export default CompareHomes;
