import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";

// /admin -> Setup calls (migration 038): the hours agents can book a call
// in, call length and notice, the Meet link, whether our calendar is linked,
// and the calls coming up.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const whenFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

async function api(body) {
  const response = await postAuthed("/api/agent-signup", body);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Something went wrong");
  return result;
}

function CalendarStatus() {
  const [status, setStatus] = useState(null);
  const check = useCallback(async () => {
    setStatus("checking");
    try {
      setStatus(await api({ action: "admin_call_status" }));
    } catch (error) {
      setStatus({ error: error.message });
    }
  }, []);
  useEffect(() => {
    check();
  }, [check]);

  let text;
  if (status === null || status === "checking") text = "Checking your calendar link...";
  else if (status.error && status.linked === undefined) text = status.error;
  else if (!status.linked)
    text =
      "Not linked yet, so only the hours below (and calls already booked) decide the free times. Add your calendar's secret iCal address as CALL_CALENDAR_ICS_URL in Vercel, then redeploy.";
  else if (status.ok)
    text = `Linked. ${status.busy} busy time${status.busy === 1 ? "" : "s"} in the next 14 days are kept free of calls.`;
  else text = `Linked, but we couldn't read it (${status.error}). Agents see no times until it works.`;

  return (
    <p className={`admin-call-status ${status?.ok ? "ok" : status?.linked ? "bad" : ""}`}>
      <strong>Your calendar:</strong> {text}{" "}
      <button type="button" className="link-button" onClick={check} disabled={status === "checking"}>
        Check again
      </button>
    </p>
  );
}

function CallRow({ call, onChanged, onMessage }) {
  const [busy, setBusy] = useState(false);
  const past = new Date(call.ends_at).getTime() < Date.now();
  const cancelled = call.status === "cancelled";

  async function cancel() {
    if (!window.confirm(`Cancel the call with ${call.name || call.email}? They'll get an email.`)) return;
    setBusy(true);
    try {
      await api({ action: "admin_cancel_call", callId: call.id });
      onMessage("Call cancelled and the agent emailed.");
      onChanged();
    } catch (error) {
      onMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={cancelled || past ? "muted" : ""}>
      <td>{whenFormatter.format(new Date(call.starts_at))}</td>
      <td>
        <strong>{call.name || "—"}</strong>
        <br />
        <small>{[call.agency, call.branch].filter(Boolean).join(" · ")}</small>
      </td>
      <td>
        {call.kind === "video" ? "Video (Meet)" : call.phone ? <a href={`tel:${call.phone}`}>{call.phone}</a> : "Phone"}
        <br />
        <small>
          <a href={`mailto:${call.email}`}>{call.email}</a>
        </small>
      </td>
      <td>
        {call.on_trial && call.trial_ends_at
          ? `Trial to ${new Date(call.trial_ends_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
          : call.on_trial
            ? "Trial"
            : "Has a code"}
        {call.note && (
          <>
            <br />
            <small>{call.note}</small>
          </>
        )}
      </td>
      <td>
        {cancelled ? (
          `Cancelled${call.cancelled_by ? ` by ${call.cancelled_by === "admin" ? "you" : "agent"}` : ""}`
        ) : past ? (
          "Done"
        ) : (
          <button type="button" className="link-button" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        )}
      </td>
    </tr>
  );
}

function SetupCalls() {
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [hours, setHours] = useState([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data: result, error } = await supabase.rpc("admin_setup_calls");
    if (error) {
      setMessage(/admin_setup_calls/.test(error.message) ? "Setup calls need database migration 038." : error.message);
      setData({ calls: [] });
      return;
    }
    setData(result);
    setSettings({ ...result.settings, meet_url: result.settings.meet_url || "" });
    setHours(result.hours || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setField = (key) => (event) =>
    setSettings({ ...settings, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value });
  const setHour = (index, key, value) => setHours(hours.map((h, i) => (i === index ? { ...h, [key]: value } : h)));

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    const bad = hours.find((h) => !h.start_time || !h.end_time || h.end_time <= h.start_time);
    if (bad) {
      setMessage(`${DAYS[bad.weekday - 1]}: the end time must be after the start.`);
      setSaving(false);
      return;
    }
    const meet = settings.meet_url.trim();
    if (meet && !/^https:\/\/\S+$/.test(meet)) {
      setMessage("The Meet link should start with https://");
      setSaving(false);
      return;
    }
    const { error } = await supabase.rpc("admin_save_setup_calls", {
      p_settings: {
        is_active: settings.is_active,
        slot_minutes: Number(settings.slot_minutes),
        min_notice_hours: Number(settings.min_notice_hours),
        days_ahead: Number(settings.days_ahead),
        meet_url: meet,
      },
      p_hours: hours.map((h) => ({ weekday: Number(h.weekday), start_time: h.start_time, end_time: h.end_time })),
    });
    setSaving(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage("Saved.");
    load();
  }

  const upcoming = (data?.calls || []).filter(
    (c) => c.status === "booked" && new Date(c.ends_at).getTime() >= Date.now()
  );

  return (
    <section className="card admin-setup-calls">
      <div className="section-header">
        <div>
          <h2>Setup calls</h2>
          <p>
            Agents book their setup call from the trial banner or the link in our emails. Free times are your hours
            below, minus calls already booked and anything busy in your calendar.
          </p>
        </div>
      </div>

      <CalendarStatus />
      {message && <p className="muted">{message}</p>}

      {data === null ? (
        <p className="muted">Loading...</p>
      ) : (
        <>
          <h3>
            Coming up{upcoming.length ? ` (${upcoming.length})` : ""}
          </h3>
          {(data.calls || []).length === 0 ? (
            <p className="muted">No calls booked yet.</p>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Agent</th>
                    <th>How</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.calls.map((call) => (
                    <CallRow key={call.id} call={call} onChanged={load} onMessage={setMessage} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {settings && (
            <form className="admin-call-settings" onSubmit={save}>
              <h3>Booking hours</h3>
              <label className="admin-call-toggle">
                <input type="checkbox" checked={settings.is_active} onChange={setField("is_active")} />
                Agents can book calls online
              </label>

              <div className="admin-call-hours">
                {hours.map((h, index) => (
                  <div key={index} className="admin-call-hour">
                    <select
                      value={h.weekday}
                      aria-label="Day"
                      onChange={(e) => setHour(index, "weekday", Number(e.target.value))}
                    >
                      {DAYS.map((d, i) => (
                        <option key={d} value={i + 1}>
                          {d}
                        </option>
                      ))}
                    </select>
                    <input
                      type="time"
                      aria-label="From"
                      value={h.start_time}
                      onChange={(e) => setHour(index, "start_time", e.target.value)}
                    />
                    <span>to</span>
                    <input
                      type="time"
                      aria-label="To"
                      value={h.end_time}
                      onChange={(e) => setHour(index, "end_time", e.target.value)}
                    />
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setHours(hours.filter((_, i) => i !== index))}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    const last = hours[hours.length - 1];
                    setHours([
                      ...hours,
                      {
                        weekday: last ? (last.weekday % 7) + 1 : 1,
                        start_time: last?.start_time || "09:00",
                        end_time: last?.end_time || "17:30",
                      },
                    ]);
                  }}
                >
                  + Add hours
                </button>
              </div>

              <div className="admin-call-fields">
                <label>
                  Call length
                  <select value={settings.slot_minutes} onChange={setField("slot_minutes")}>
                    {[10, 15, 20, 30, 45, 60].map((m) => (
                      <option key={m} value={m}>
                        {m} minutes
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Notice (hours)
                  <input
                    type="number"
                    min={0}
                    max={72}
                    value={settings.min_notice_hours}
                    onChange={setField("min_notice_hours")}
                  />
                </label>
                <label>
                  Days ahead
                  <input type="number" min={1} max={60} value={settings.days_ahead} onChange={setField("days_ahead")} />
                </label>
                <label className="wide">
                  Google Meet link (optional: offers a video call)
                  <input
                    type="url"
                    placeholder="https://meet.google.com/abc-defg-hij"
                    value={settings.meet_url}
                    onChange={setField("meet_url")}
                  />
                </label>
              </div>
              <button type="submit" className="primary-button" disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}

export default SetupCalls;
