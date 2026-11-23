import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";

// Where the buyer is with their search (migration 029). One tap tells every
// agent at once: while paused or found, agents' matching homes stop coming
// and the agents they've booked with see it. Looking again catches up on the
// homes they missed.

export const STATUS_LABELS = {
  searching: "Looking",
  paused: "Paused",
  found: "Found somewhere",
};

const PAUSES = [
  { days: 14, label: "2 weeks" },
  { days: 30, label: "1 month" },
  { days: null, label: "Until I switch back" },
];

function addDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function niceDate(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function statusSummary(status, pausedUntil) {
  if (status === "found") return "Found somewhere: agents have stopped sending you homes.";
  if (status === "paused")
    return pausedUntil
      ? `Paused until ${niceDate(pausedUntil)}: agents won't send you homes until then.`
      : "Paused: agents won't send you homes until you switch back.";
  return "Looking: agents send you homes that fit your searches.";
}

// Send this person any live homes their searches fit that came out while
// they weren't looking (api/send-listing.js for_search). Best effort.
export async function resumeSearches() {
  const { data } = await supabase.from("buyer_searches").select("id").eq("is_active", true);
  let sent = 0;
  for (const search of data || []) {
    const response = await postAuthed("/api/send-listing", { action: "for_search", searchId: search.id }).catch(() => null);
    const body = await response?.json().catch(() => ({}));
    sent += body?.sent || 0;
  }
  return sent;
}

export async function setSearchStatus(status, pausedUntil = null) {
  const { data, error } = await supabase.rpc("set_search_status", {
    p_status: status,
    p_paused_until: pausedUntil,
  });
  if (error) throw error;
  let caughtUp = 0;
  if (status === "searching") caughtUp = await resumeSearches();
  return { ...data, caughtUp };
}

function SearchStatus({ household, onChange }) {
  const [status, setStatus] = useState(household?.search_status || "searching");
  const [pausedUntil, setPausedUntil] = useState(household?.paused_until || null);
  const [choosingPause, setChoosingPause] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    setStatus(household?.search_status || "searching");
    setPausedUntil(household?.paused_until || null);
  }, [household?.search_status, household?.paused_until]);

  if (household && !("search_status" in household)) {
    return <p className="muted">Search status isn't switched on yet (database migration 029).</p>;
  }

  async function choose(next, days) {
    const until = next === "paused" && days ? addDays(days) : null;
    setBusy(true);
    setNote("");
    try {
      const result = await setSearchStatus(next, until);
      setStatus(next);
      setPausedUntil(until);
      setChoosingPause(false);
      setNote(
        next === "searching"
          ? result.caughtUp
            ? `Welcome back. ${result.caughtUp} matching home${result.caughtUp === 1 ? "" : "s"} added to your list.`
            : "Welcome back. Agents will send you matching homes again."
          : next === "found"
            ? "Congratulations! Agents have been told."
            : "Done. Agents have been told you're taking a break."
      );
      onChange?.();
    } catch (error) {
      console.error("Could not change search status:", error);
      setNote("Couldn't save that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="search-status">
      <div className="search-status-options" role="radiogroup" aria-label="Your search">
        {Object.entries(STATUS_LABELS).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={status === key}
            className={`search-status-option${status === key ? " active" : ""}`}
            disabled={busy}
            onClick={() => {
              if (key === "paused") setChoosingPause(true);
              else if (key !== status) choose(key);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {choosingPause && (
        <div className="search-status-pause">
          <span>Pause for</span>
          {PAUSES.map((p) => (
            <button key={p.label} type="button" className="secondary-button" disabled={busy} onClick={() => choose("paused", p.days)}>
              {p.label}
            </button>
          ))}
          <button type="button" className="link-button" onClick={() => setChoosingPause(false)}>
            Cancel
          </button>
        </div>
      )}

      <p className="muted">{statusSummary(status, pausedUntil)}</p>
      <p className="muted small">
        Agents you've booked a viewing or made an offer with see this, so they know whether to call.
      </p>
      {note && <p className="search-status-note" role="status">{note}</p>}
    </div>
  );
}

export default SearchStatus;
