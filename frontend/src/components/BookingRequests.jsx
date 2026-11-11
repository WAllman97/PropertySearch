import { useState } from "react";
import { postAuthed } from "../lib/api";

const whenFormatter = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// Pending agent requests (accept / decline) and upcoming confirmed calls.
function BookingRequests({ requests, onChanged }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");

  const now = Date.now();
  const pending = requests.filter(
    (r) => r.status === "pending" && new Date(r.ends_at).getTime() > now
  );
  const upcoming = requests.filter(
    (r) => r.status === "accepted" && new Date(r.ends_at).getTime() > now
  );

  async function respond(request, action) {
    setBusyId(request.id);
    setError("");

    try {
      const response = await postAuthed("/api/booking-respond", {
        requestId: request.id,
        action,
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not update the request");

      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  if (pending.length === 0 && upcoming.length === 0) {
    return null;
  }

  return (
    <div className="booking-requests">
      {pending.length > 0 && (
        <>
          <h3>
            Agent requests <span className="booking-count">{pending.length}</span>
          </h3>
          {pending.map((r) => (
            <div className="booking-request" key={r.id}>
              <div>
                <span className={`booking-kind-tag ${r.kind}`}>
                  {r.kind === "viewing" ? "Viewing" : "Call"}
                </span>
                <strong>{whenFormatter.format(new Date(r.starts_at))}</strong>
                <p>
                  {r.agent_name}
                  {r.agency ? `, ${r.agency}` : ""}
                  {r.agent_phone ? ` · ${r.agent_phone}` : ""}
                </p>
                {(r.property_address || r.property_url) && (
                  <p className="muted">
                    {r.property_address}
                    {r.property_url && (
                      <>
                        {r.property_address ? " · " : ""}
                        <a href={r.property_url} target="_blank" rel="noreferrer">
                          Listing
                        </a>
                      </>
                    )}
                  </p>
                )}
                {r.message && <p className="booking-request-message">“{r.message}”</p>}
              </div>
              <div className="button-row">
                <button
                  type="button"
                  className="primary"
                  disabled={busyId === r.id}
                  onClick={() => respond(r, "accept")}
                >
                  Accept
                </button>
                <button
                  type="button"
                  disabled={busyId === r.id}
                  onClick={() => respond(r, "decline")}
                >
                  Decline
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {upcoming.length > 0 && (
        <>
          <h3>Upcoming calls & booked viewings</h3>
          <ul className="booking-upcoming">
            {upcoming.map((r) => (
              <li key={r.id}>
                <span className={`booking-kind-tag ${r.kind}`}>
                  {r.kind === "viewing" ? "Viewing" : "Call"}
                </span>
                <strong>{whenFormatter.format(new Date(r.starts_at))}</strong>
                <span>
                  {r.agent_name}
                  {r.agency ? `, ${r.agency}` : ""}
                  {r.agent_phone ? ` · ${r.agent_phone}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {error && <p className="booking-error">{error}</p>}
    </div>
  );
}

export default BookingRequests;
