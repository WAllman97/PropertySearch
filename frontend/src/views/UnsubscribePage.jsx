import { useState } from "react";
import { apiUrl } from "../lib/platform";

// /unsubscribe?t=<token>&kind=matches|price_drops: from the footer of a "new
// match" or price-cut email. A button, not an automatic unsubscribe, because
// mail scanners open links on their own (api/buyer-signup.js, migration 028).

const KINDS = {
  matches: "new homes agents send you",
  price_drops: "price cuts on homes you've saved",
};

function UnsubscribePage() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("t") || "";
  const kind = KINDS[params.get("kind")] ? params.get("kind") : null;
  const [state, setState] = useState("ask"); // ask | busy | off | on | error

  async function change(resubscribe) {
    setState("busy");
    const response = await fetch(
      apiUrl(`/api/buyer-signup?unsubscribe=${encodeURIComponent(token)}&kind=${kind}`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resubscribe }),
      }
    ).catch(() => null);
    setState(response?.ok ? (resubscribe ? "on" : "off") : "error");
  }

  if (!kind || !token) {
    return (
      <div className="booking-shell">
        <section className="card check-email">
          <h3>That link isn't complete</h3>
          <p>You can turn emails on and off in ViewPal → Settings.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="booking-shell">
      <section className="card check-email">
        {state === "off" ? (
          <>
            <h3>You're unsubscribed</h3>
            <p>No more emails about {KINDS[kind]}. You'll still see them in the app.</p>
            <button type="button" className="link-button" onClick={() => change(true)}>
              Changed your mind? Subscribe again
            </button>
          </>
        ) : state === "on" ? (
          <>
            <h3>You're subscribed again</h3>
            <p>We'll email you about {KINDS[kind]}.</p>
          </>
        ) : (
          <>
            <h3>Stop emails about {KINDS[kind]}?</h3>
            <p className="muted">You'll still see them in the app and on your phone.</p>
            {state === "error" && (
              <p className="booking-error">That link isn't valid any more. Change your emails in Settings.</p>
            )}
            <button type="button" className="primary-button" disabled={state === "busy"} onClick={() => change(false)}>
              {state === "busy" ? "Saving..." : "Unsubscribe"}
            </button>
          </>
        )}
      </section>
    </div>
  );
}

export default UnsubscribePage;
