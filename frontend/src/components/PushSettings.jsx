import { useEffect, useState } from "react";
import { disablePush, enablePush, pushStatus } from "../lib/push";

// "Phone notifications" switch in Settings. Only rendered in the iPhone app.
function PushSettings() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    pushStatus().then(setStatus).catch(() => setStatus("off"));
  }, []);

  async function toggle() {
    setBusy(true);
    setError("");
    try {
      setStatus(status === "on" ? await disablePush() : await enablePush());
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  if (!status) return <p>Checking notifications...</p>;

  if (status === "denied") {
    return (
      <p className="push-note">
        Notifications are switched off for PropertySearch. To turn them on, open the iPhone
        Settings app → PropertySearch → Notifications.
      </p>
    );
  }

  return (
    <div className="push-settings">
      <p className="push-note">
        {status === "on"
          ? "On for this phone. You'll get a notification when an agent sends a home that matches your search, and the day before a viewing."
          : "Get a notification when an agent sends a home that matches your search, and the day before a viewing."}
      </p>
      <button
        type="button"
        className={status === "on" ? "secondary-button" : "primary-button"}
        onClick={toggle}
        disabled={busy}
      >
        {busy ? "One moment..." : status === "on" ? "Turn off on this phone" : "Turn on notifications"}
      </button>
      {error && <p className="booking-error">{error}</p>}
    </div>
  );
}

export default PushSettings;
