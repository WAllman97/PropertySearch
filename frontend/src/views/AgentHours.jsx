import { useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// An agent's weekly viewing hours (migration 022): set once, and every
// listing gets bookable times from them, kept topped up a few weeks ahead.
// Amendable any time: change the hours, add time off, turn a listing off,
// or remove single times on the listing.

const WEEKDAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
];

// What a new agent starts from: weekday evenings and Saturday morning.
const DEFAULT_DAYS = {
  1: [{ starts: "17:00", ends: "19:00" }],
  2: [{ starts: "17:00", ends: "19:00" }],
  3: [{ starts: "17:00", ends: "19:00" }],
  4: [{ starts: "17:00", ends: "19:00" }],
  5: [{ starts: "17:00", ends: "19:00" }],
  6: [{ starts: "10:00", ends: "13:00" }],
  7: [],
};
const DEFAULT_SETTINGS = {
  enabled: true,
  slot_minutes: 20,
  travel_minutes: 15,
  days_ahead: 14,
  notice_hours: 2,
};

const LENGTH_OPTIONS = [15, 20, 30, 45, 60];
const TRAVEL_OPTIONS = [
  [0, "None"],
  [10, "10 min"],
  [15, "15 min"],
  [20, "20 min"],
  [30, "30 min"],
];
const AHEAD_OPTIONS = [
  [7, "1 week"],
  [14, "2 weeks"],
  [21, "3 weeks"],
  [28, "4 weeks"],
];
const NOTICE_OPTIONS = [
  [0, "None"],
  [1, "1 hour"],
  [2, "2 hours"],
  [4, "4 hours"],
  [24, "A day"],
];

const hhmm = (t) => String(t || "").slice(0, 5);

function daysFromRows(rows) {
  const days = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
  for (const row of [...rows].sort((a, b) => hhmm(a.starts).localeCompare(hhmm(b.starts)))) {
    days[row.weekday].push({ starts: hhmm(row.starts), ends: hhmm(row.ends) });
  }
  return days;
}

// "Mon–Fri 17:00–19:00 · Sat 10:00–13:00"
export function hoursSummary(rows) {
  const days = daysFromRows(rows);
  const text = (d) => days[d].map((p) => `${p.starts}–${p.ends}`).join(", ");
  const parts = [];
  let run = null;
  for (const [d, name] of WEEKDAYS) {
    const t = text(d);
    if (t && run && run.text === t && run.last === d - 1) {
      run.last = d;
      run.lastName = name;
    } else {
      if (run) parts.push(run);
      run = t ? { text: t, first: d, last: d, firstName: name, lastName: name } : null;
    }
  }
  if (run) parts.push(run);
  return parts
    .map((r) =>
      r.first === r.last
        ? `${r.firstName} ${r.text}`
        : `${r.firstName}${r.last - r.first === 1 ? ", " : "–"}${r.lastName} ${r.text}`
    )
    .join(" · ");
}

function londonDay(iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(iso));
}

function prettyDate(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// The form's starting values, from what's saved (or defaults for a new agent).
function settingsFrom(availability) {
  return availability
    ? {
        enabled: availability.enabled,
        slot_minutes: availability.slot_minutes,
        travel_minutes: availability.travel_minutes,
        days_ahead: availability.days_ahead,
        notice_hours: availability.notice_hours,
      }
    : DEFAULT_SETTINGS;
}

function daysFrom(availability, hours) {
  return availability ? daysFromRows(hours) : DEFAULT_DAYS;
}

function todayLondon() {
  return londonDay(new Date().toISOString());
}

function TimeOff({ agentId, timeOff, bookedSlots, onChanged }) {
  const [form, setForm] = useState({ from: "", to: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const today = todayLondon();
  const upcoming = timeOff.filter((t) => t.ends_on >= today);

  async function add(event) {
    event.preventDefault();
    setError("");
    const to = form.to || form.from;
    if (!form.from || to < form.from) {
      setError("Pick the first day, and a last day on or after it.");
      return;
    }
    setBusy(true);
    const { error: insertError } = await supabase.from("agent_time_off").insert({
      agent_id: agentId,
      starts_on: form.from,
      ends_on: to,
      note: form.note.trim() || null,
    });
    if (!insertError) await supabase.rpc("sync_pattern_slots", { p_agent: agentId });
    setBusy(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setForm({ from: "", to: "", note: "" });
    onChanged();
  }

  async function remove(id) {
    setBusy(true);
    await supabase.from("agent_time_off").delete().eq("id", id);
    await supabase.rpc("sync_pattern_slots", { p_agent: agentId });
    setBusy(false);
    onChanged();
  }

  return (
    <div className="agent-time-off">
      <h4>Time off</h4>
      <p className="muted">
        Free times on these days come off every listing. Viewings already booked stay booked.
      </p>
      {upcoming.length > 0 && (
        <ul className="agent-time-off-list">
          {upcoming.map((t) => {
            const booked = bookedSlots.filter((s) => {
              const day = londonDay(s.starts_at);
              return day >= t.starts_on && day <= t.ends_on;
            }).length;
            return (
              <li key={t.id}>
                <span>
                  <strong>
                    {prettyDate(t.starts_on)}
                    {t.ends_on !== t.starts_on ? ` – ${prettyDate(t.ends_on)}` : ""}
                  </strong>
                  {t.note ? ` · ${t.note}` : ""}
                  {booked > 0 && (
                    <span className="agent-warning">
                      {" "}
                      · {booked} viewing{booked === 1 ? " is" : "s are"} still booked then: cancel{" "}
                      {booked === 1 ? "it" : "them"} on the listing if you can't do{" "}
                      {booked === 1 ? "it" : "them"}.
                    </span>
                  )}
                </span>
                <button type="button" className="link-button" disabled={busy} onClick={() => remove(t.id)}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form className="agent-times-row agent-time-off-form" onSubmit={add}>
        <label>
          From
          <input
            type="date"
            min={today}
            required
            value={form.from}
            onChange={(e) => setForm({ ...form, from: e.target.value })}
          />
        </label>
        <label>
          To (optional)
          <input
            type="date"
            min={form.from || today}
            value={form.to}
            onChange={(e) => setForm({ ...form, to: e.target.value })}
          />
        </label>
        <label>
          Note (optional)
          <input
            maxLength={100}
            placeholder="e.g. Holiday"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </label>
        <div className="agent-time-off-add">
          <button type="submit" className="secondary-button" disabled={busy}>
            Add time off
          </button>
        </div>
      </form>
      {error && <p className="booking-error">{error}</p>}
    </div>
  );
}

export default function AgentHours({ agentId, availability, hours, timeOff, bookedSlots, onChanged }) {
  const isNew = !availability;
  const [editing, setEditing] = useState(isNew);
  const [settings, setSettings] = useState(() => settingsFrom(availability));
  const [days, setDays] = useState(() => daysFrom(availability, hours));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const summary = useMemo(() => hoursSummary(hours), [hours]);
  const set = (key) => (event) =>
    setSettings({ ...settings, [key]: Number(event.target.value) });

  function setPeriod(day, index, key, value) {
    setDays({
      ...days,
      [day]: days[day].map((p, i) => (i === index ? { ...p, [key]: value } : p)),
    });
  }

  function toggleDay(day) {
    setDays({
      ...days,
      [day]: days[day].length ? [] : [{ starts: day >= 6 ? "10:00" : "17:00", ends: day >= 6 ? "13:00" : "19:00" }],
    });
  }

  function addPeriod(day) {
    const last = days[day][days[day].length - 1];
    setDays({ ...days, [day]: [...days[day], { starts: last?.ends || "12:00", ends: "" }] });
  }

  function removePeriod(day, index) {
    setDays({ ...days, [day]: days[day].filter((_, i) => i !== index) });
  }

  // Cancel / Close throws away unsaved edits; otherwise the next Change then
  // Save would quietly save them.
  function discardEdits() {
    setSettings(settingsFrom(availability));
    setDays(daysFrom(availability, hours));
    setError("");
    setEditing(false);
  }

  async function save(event) {
    event.preventDefault();
    setError("");
    setMessage("");
    const rows = [];
    for (const [d, name] of WEEKDAYS) {
      const periods = [...days[d]].sort((a, b) => a.starts.localeCompare(b.starts));
      for (let i = 0; i < periods.length; i += 1) {
        const p = periods[i];
        if (!p.starts || !p.ends || p.ends <= p.starts) {
          setError(`${name}: each period needs an end time after its start.`);
          return;
        }
        if (i > 0 && p.starts < periods[i - 1].ends) {
          setError(`${name}: two periods overlap.`);
          return;
        }
        rows.push({ weekday: d, starts: p.starts, ends: p.ends });
      }
    }
    if (settings.enabled && !rows.length) {
      setError("Tick at least one day, or switch weekly hours off.");
      return;
    }

    setBusy(true);
    const { data, error: saveError } = await supabase.rpc("agent_save_availability", {
      p_enabled: settings.enabled,
      p_slot_minutes: settings.slot_minutes,
      p_travel_minutes: settings.travel_minutes,
      p_days_ahead: settings.days_ahead,
      p_notice_hours: settings.notice_hours,
      p_hours: rows,
    });
    setBusy(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    setEditing(false);
    setMessage(
      settings.enabled
        ? `Saved. ${data} free viewing time${data === 1 ? "" : "s"} across your listings for the next ${
            settings.days_ahead / 7
          } week${settings.days_ahead === 7 ? "" : "s"}.`
        : "Saved. Weekly hours are off: only times you add by hand are offered."
    );
    onChanged();
  }

  return (
    <section className="card agent-hours" id="agent-hours" aria-labelledby="agent-hours-title">
      <div className="section-header">
        <div>
          <h3 id="agent-hours-title">Your viewing hours</h3>
          {isNew ? (
            <p className="muted">
              Set these once and every listing gets bookable times automatically, a few weeks
              ahead. When a buyer books one home, clashing times on your other homes are taken
              off, so you're never double-booked. You can change anything later.
            </p>
          ) : availability.enabled ? (
            <p className="muted">
              {summary || "No days set"} · {availability.slot_minutes}-min viewings ·{" "}
              {availability.days_ahead / 7} week{availability.days_ahead === 7 ? "" : "s"} ahead
            </p>
          ) : (
            <p className="muted">Weekly hours are off: only times you add by hand are offered.</p>
          )}
        </div>
        {!isNew && (
          <button type="button" className="secondary-button" onClick={() => (editing ? discardEdits() : setEditing(true))}>
            {editing ? "Close" : "Change"}
          </button>
        )}
      </div>
      {message && !editing && <p className="agent-saved">{message}</p>}

      {editing && (
        <form className="agent-hours-form" onSubmit={save}>
          {!isNew && (
            <label className="agent-hours-switch">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
              />
              Offer my weekly hours on my listings
            </label>
          )}

          <fieldset className="agent-week" disabled={!settings.enabled}>
            <legend className="visually-hidden">Days and times</legend>
            {WEEKDAYS.map(([d, name]) => (
              <div key={d} className={`agent-week-day ${days[d].length ? "on" : ""}`}>
                <label className="agent-week-name">
                  <input type="checkbox" checked={days[d].length > 0} onChange={() => toggleDay(d)} />
                  {name}
                </label>
                <div className="agent-week-periods">
                  {days[d].length === 0 && <span className="muted">Not available</span>}
                  {days[d].map((p, i) => (
                    <span key={i} className="agent-week-period">
                      <input
                        type="time"
                        step={300}
                        aria-label={`${name} from`}
                        value={p.starts}
                        onChange={(e) => setPeriod(d, i, "starts", e.target.value)}
                      />
                      <span aria-hidden="true">–</span>
                      <input
                        type="time"
                        step={300}
                        aria-label={`${name} to`}
                        value={p.ends}
                        onChange={(e) => setPeriod(d, i, "ends", e.target.value)}
                      />
                      <button
                        type="button"
                        className="link-button"
                        aria-label={`Remove ${name} ${p.starts}`}
                        onClick={() => removePeriod(d, i)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {days[d].length > 0 && days[d].length < 4 && (
                    <button type="button" className="link-button" onClick={() => addPeriod(d)}>
                      + another time
                    </button>
                  )}
                </div>
              </div>
            ))}
          </fieldset>

          <div className="agent-times-row">
            <label>
              Each viewing
              <select value={settings.slot_minutes} onChange={set("slot_minutes")} disabled={!settings.enabled}>
                {LENGTH_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </label>
            <label>
              Travel between homes
              <select value={settings.travel_minutes} onChange={set("travel_minutes")} disabled={!settings.enabled}>
                {TRAVEL_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Offer times
              <select value={settings.days_ahead} onChange={set("days_ahead")} disabled={!settings.enabled}>
                {AHEAD_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l} ahead
                  </option>
                ))}
              </select>
            </label>
            <label>
              Shortest notice
              <select value={settings.notice_hours} onChange={set("notice_hours")} disabled={!settings.enabled}>
                {NOTICE_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="agent-times-actions">
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? "Saving..." : isNew ? "Use these hours" : "Save hours"}
            </button>
            {!isNew && (
              <button type="button" className="link-button" onClick={discardEdits}>
                Cancel
              </button>
            )}
            {error && <span className="booking-error">{error}</span>}
          </div>
          <p className="muted agent-hours-note">
            Changing hours only changes free times. Booked viewings never move.
          </p>
        </form>
      )}

      {!isNew && (
        <TimeOff agentId={agentId} timeOff={timeOff} bookedSlots={bookedSlots} onChanged={onChanged} />
      )}
    </section>
  );
}
