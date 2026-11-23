import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";
import { apiUrl } from "../lib/platform";

// Already signed in and opened a partner's invite link (/join/<code>): join
// their household in one tap, bringing your saved homes with you
// (api/buyer-signup.js join). Both partners downloading the app separately
// is the normal case, so this can't be a dead end.
function JoinHousehold({ invite, onDone }) {
  const [info, setInfo] = useState(null);
  const [homes, setHomes] = useState(0);
  const [bringHomes, setBringHomes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(apiUrl(`/api/buyer-signup?invite=${encodeURIComponent(invite)}`))
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        setInfo(response.ok ? body : { error: body.error || "This invite link isn't valid any more." });
      })
      .catch(() => setInfo({ error: "Couldn't check the invite link. Please try again." }));
    supabase
      .from("properties")
      .select("id", { count: "exact", head: true })
      .not("status", "in", "(ignored,archived,lost)")
      .then(({ count }) => setHomes(count || 0));
  }, [invite]);

  function close() {
    window.history.replaceState(null, "", "/");
    onDone();
  }

  async function join() {
    setBusy(true);
    setError("");
    try {
      const response = await postAuthed("/api/buyer-signup", { action: "join", invite, bringHomes });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not join. Please try again.");
      // Everything (list, calendar, settings) now belongs to the new household.
      window.location.replace("/");
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (!info) return null;

  if (info.error) {
    return (
      <div className="auth-banner" role="status">
        {info.error}{" "}
        <button type="button" className="link-button" onClick={close}>
          OK
        </button>
      </div>
    );
  }

  return (
    <section className="card join-household" role="dialog" aria-label="Join household">
      <h3>Join {info.householdName}?</h3>
      <p className="muted">
        You'll share one list of homes, one viewings calendar and your notes. Your saved searches
        come with you.
      </p>
      {homes > 0 && (
        <label className="agent-auto">
          <input type="checkbox" checked={bringHomes} onChange={(e) => setBringHomes(e.target.checked)} />
          Bring my {homes} saved home{homes === 1 ? "" : "s"} with me
        </label>
      )}
      {error && <p className="booking-error">{error}</p>}
      <div className="delete-account-actions">
        <button type="button" className="primary-button" disabled={busy} onClick={join}>
          {busy ? "Joining..." : "Join"}
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={close}>
          Not now
        </button>
      </div>
    </section>
  );
}

export default JoinHousehold;
