import { useCallback, useEffect, useMemo, useState } from "react";
import { postAuthed } from "../lib/api";
import { friendlyError } from "../lib/errors";

// Book (or move, or cancel) the agent's setup call with ViewPal, migration
// 038. Same idea as a buyer booking a viewing: pick a day, pick a time,
// done. The free times already leave out anything busy in our calendar.

const dayFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
});
const longFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "long",
  day: "numeric",
  month: "long",
});
const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const whenText = (iso) => `${longFormatter.format(new Date(iso))}, ${timeFormatter.format(new Date(iso))}`;

async function post(body) {
  const response = await postAuthed("/api/agent-signup", body);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "Something went wrong. Please try again.");
    error.taken = result.taken;
    throw error;
  }
  return result;
}

// The booked call, shown on the banner: "Setup call booked: Thursday 3 December, 10:15".
export function useSetupCall(enabled = true) {
  const [state, setState] = useState(null);
  const reload = useCallback(async () => {
    try {
      setState(await post({ action: "call_slots", withSlots: false }));
    } catch {
      setState(null);
    }
  }, []);
  useEffect(() => {
    if (enabled) reload();
  }, [enabled, reload]);
  return [state, reload];
}

// The picker. onDone(call|null) when booked, moved or cancelled.
// onFallback: show "Rather we rang you?" (the request-a-call form).
export function SetupCallPicker({ call, defaultPhone = "", onDone, onClose, onFallback }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [day, setDay] = useState("");
  const [selected, setSelected] = useState("");
  const [kind, setKind] = useState(call?.kind || "phone");
  const [phone, setPhone] = useState(call?.phone || defaultPhone);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await post({ action: "call_slots" });
      setData(result);
      if (!phone && result.phone) setPhone(result.phone);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
    // phone: only the first time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const days = useMemo(() => {
    const groups = new Map();
    for (const iso of data?.slots || []) {
      const key = dayFormatter.format(new Date(iso));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(iso);
    }
    return [...groups.entries()];
  }, [data]);

  const openDay = days.find(([key]) => key === day) || days[0];

  async function book(event) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const result = await post({ action: "book_call", startsAt: selected, kind, phone, note });
      onDone?.(result.call);
    } catch (err) {
      setError(friendlyError(err));
      if (err.taken) {
        setSelected("");
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="setup-call-note">Finding free times...</p>;

  if (!data?.active || data.unavailable || !days.length) {
    return (
      <div className="setup-call">
        <p className="setup-call-note">
          {data && !data.active
            ? "Online booking for calls is paused at the moment."
            : data?.unavailable
              ? "We can't show our free times right now."
              : "There are no free times in the next couple of weeks."}{" "}
          Ask us to ring you instead and we'll be in touch the same day.
        </p>
        {error && <p className="booking-error">{error}</p>}
        <div className="agent-trial-actions">
          {onFallback && (
            <button type="button" className="secondary-button" onClick={onFallback}>
              Ask us to ring you
            </button>
          )}
          {onClose && (
            <button type="button" className="link-button" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <form className="setup-call" onSubmit={book}>
      <p className="setup-call-note">
        {call
          ? `Pick a new time. Your call is now ${whenText(call.startsAt)}.`
          : `Pick a time for a ${data.slotMinutes}-minute call. We'll set up your branch and answer any questions.`}
      </p>

      <div className="setup-call-days" role="tablist" aria-label="Day">
        {days.map(([key, times]) => (
          <button
            type="button"
            role="tab"
            key={key}
            aria-selected={openDay[0] === key}
            className={openDay[0] === key ? "selected" : ""}
            onClick={() => {
              setDay(key);
              setSelected("");
            }}
          >
            {key}
            <small>
              {times.length} time{times.length === 1 ? "" : "s"}
            </small>
          </button>
        ))}
      </div>

      <div className="viewing-times setup-call-times">
        {openDay[1].map((iso) => (
          <button
            type="button"
            key={iso}
            className={selected === iso ? "selected" : ""}
            aria-pressed={selected === iso}
            onClick={() => setSelected(iso)}
          >
            {timeFormatter.format(new Date(iso))}
          </button>
        ))}
      </div>

      {selected && (
        <div className="setup-call-confirm">
          {data.video && (
            <div className="setup-call-kind" role="radiogroup" aria-label="Call type">
              <label>
                <input type="radio" name="call-kind" checked={kind === "phone"} onChange={() => setKind("phone")} />
                Phone call
              </label>
              <label>
                <input type="radio" name="call-kind" checked={kind === "video"} onChange={() => setKind("video")} />
                Video call (Google Meet, so we can share screens)
              </label>
            </div>
          )}
          <div className="agent-trial-fields">
            {kind === "phone" && (
              <label>
                Number we should ring
                <input type="tel" required maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
              </label>
            )}
            <label>
              Anything we should know? (optional)
              <input
                maxLength={500}
                placeholder="e.g. 3 negotiators at the branch"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </div>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Booking..." : `${call ? "Move to" : "Book"} ${whenText(selected)}`}
          </button>
        </div>
      )}

      {error && <p className="booking-error">{error}</p>}

      <div className="agent-trial-actions">
        {onFallback && (
          <button type="button" className="link-button" onClick={onFallback}>
            None of these work? Ask us to ring you
          </button>
        )}
        {onClose && (
          <button type="button" className="link-button" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </form>
  );
}

// "Setup call booked" with Move and Cancel.
export function SetupCallBooked({ call, onMove, onCancelled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function cancel() {
    if (!window.confirm("Cancel your setup call?")) return;
    setBusy(true);
    setError("");
    try {
      await post({ action: "cancel_call" });
      onCancelled?.();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setup-call-booked">
      <p>
        <strong>Setup call booked:</strong> {whenText(call.startsAt)}.{" "}
        {call.kind === "video"
          ? "The Google Meet link is in your email and calendar invite."
          : `We'll ring you${call.phone ? ` on ${call.phone}` : ""}.`}
      </p>
      <div className="agent-trial-actions">
        <button type="button" className="link-button" onClick={onMove} disabled={busy}>
          Move it
        </button>
        <button type="button" className="link-button" onClick={cancel} disabled={busy}>
          {busy ? "Cancelling..." : "Cancel it"}
        </button>
      </div>
      {error && <p className="booking-error">{error}</p>}
    </div>
  );
}
