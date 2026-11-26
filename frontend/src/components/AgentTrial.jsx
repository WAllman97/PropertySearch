import { useState } from "react";
import { postAuthed } from "../lib/api";
import { friendlyError } from "../lib/errors";
import "./AgentTrial.css";

// The free-trial banner for agents a buyer invited (migration 034). Shown on
// the agent's Today and Settings tabs. Nothing shows for agents on a branch
// code. When the trial ends, buyers can't book new viewings (slot_blocked)
// until the agent adds their branch's code, so both ways to get one are
// right here: type a code, or ask us for one.

const CONTACT_EMAIL = "hello@viewpal.app";
const DAY = 24 * 3600 * 1000;

async function post(body) {
  const response = await postAuthed("/api/agent-signup", body);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result;
}

const shortDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });

export function AgentTrialBanner({ agent, onChanged }) {
  const [entering, setEntering] = useState(false);
  const [code, setCode] = useState("");
  const [contact, setContact] = useState(false);
  const [details, setDetails] = useState(() => ({
    agency: agent?.agency || "",
    branch: agent?.branch || "",
    phone: agent?.phone || "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requested, setRequested] = useState(false);
  // The agency a code just moved them onto. Kept here because reloading the
  // agent (now with a code) would otherwise hide the banner, success and all.
  const [converted, setConverted] = useState("");

  if (converted) {
    return (
      <section className="agent-trial agent-trial-ok" role="status">
        <p className="agent-trial-notice">You're on {converted} now. Everything you've set up stays.</p>
        <div className="agent-trial-actions">
          <button type="button" className="link-button" onClick={() => setConverted("")}>
            Dismiss
          </button>
        </div>
      </section>
    );
  }

  if (!agent?.trial_ends_at || agent.signup_code) return null;

  const left = new Date(agent.trial_ends_at).getTime() - Date.now();
  const ended = left <= 0;
  const days = Math.max(1, Math.ceil(left / DAY));
  const tone = ended ? "ended" : days <= 4 ? "warn" : "ok";

  async function addCode(event) {
    event.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await post({ action: "add_code", code: code.trim() });
      setConverted(result.agency || agent.agency || "your branch");
      setEntering(false);
      onChanged?.();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function requestCode(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post({ action: "request_code", ...details });
      setRequested(true);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (key) => (event) => setDetails({ ...details, [key]: event.target.value });
  const mailto = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
    `Branch code for ${[details.agency, details.branch].filter(Boolean).join(", ")}`
  )}`;

  return (
    <section className={`agent-trial agent-trial-${tone}`} role="status">
      <div className="agent-trial-head">
        <strong>
          {ended
            ? "Trial ended — buyers can't book new viewings"
            : `Free trial: ${days} day${days === 1 ? "" : "s"} left`}
        </strong>
        <span>
          {ended
            ? "Your listings and booked viewings are safe. Add your branch code to switch booking back on."
            : `Buyers can book your times until ${shortDate(agent.trial_ends_at)}. Add your branch code to keep it going.`}
        </span>
      </div>

      {entering ? (
        <form className="agent-trial-code" onSubmit={addCode}>
          <label>
            <span className="visually-hidden">Branch code</span>
            <input
              autoFocus
              maxLength={40}
              autoCapitalize="characters"
              placeholder="e.g. BROOKS-WANDSWORTH-7F3A2"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button type="submit" className="primary-button" disabled={busy || !code.trim()}>
            {busy ? "Checking..." : "Add code"}
          </button>
          <button type="button" className="link-button" onClick={() => setEntering(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="agent-trial-actions">
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setEntering(true);
              setError("");
            }}
          >
            Have a branch code? Enter it
          </button>
          <button type="button" className="link-button" onClick={() => setContact(!contact)}>
            Get a code for your branch
          </button>
        </div>
      )}

      {contact && !entering && (
        <div className="agent-trial-contact">
          {requested ? (
            <p>
              <strong>Request sent.</strong> We'll be in touch at {agent.email}
              {details.phone ? ` or on ${details.phone}` : ""} to arrange a quick call and set up your branch. It's
              usually the same day.
            </p>
          ) : (
            <form onSubmit={requestCode}>
              <p>
                We set up each branch on a 10-minute call. Email us at <a href={mailto}>{CONTACT_EMAIL}</a> to book
                one, or check your details and tap Request a call and we'll get in touch.
                {agent.code_requested_at && ` You asked on ${shortDate(agent.code_requested_at)}.`}
              </p>
              <div className="agent-trial-fields">
                <label>
                  Agency
                  <input required maxLength={100} value={details.agency} onChange={set("agency")} />
                </label>
                <label>
                  Branch
                  <input maxLength={100} value={details.branch} onChange={set("branch")} />
                </label>
                <label>
                  Phone (for the call)
                  <input type="tel" maxLength={40} value={details.phone} onChange={set("phone")} />
                </label>
              </div>
              <button type="submit" className="secondary-button" disabled={busy}>
                {busy ? "Sending..." : "Request a call"}
              </button>
            </form>
          )}
        </div>
      )}

      {error && <p className="booking-error">{error}</p>}
    </section>
  );
}

export default AgentTrialBanner;
