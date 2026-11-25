import { useEffect, useState } from "react";
import { apiUrl } from "../lib/platform";
import { CheckYourEmail } from "./ConfirmEmail";

// /agent?invite=<token>: sign-up from a buyer's invite (migration 034). No
// sign-up code: the account starts a 14-day free trial. The name and email
// come from the invite, and the email is fixed when the buyer gave one (the
// invite was sent to that address). /agent?invite=<token>&stop=1 is the
// "don't email me again" link; nothing changes until the button is pressed,
// because mail scanners open links by themselves.

export function inviteFromLink() {
  const token = new URLSearchParams(window.location.search).get("invite") || "";
  return /^[0-9a-f-]{36}$/i.test(token) ? token : "";
}

async function post(body) {
  const response = await fetch(apiUrl("/api/agent-signup"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result;
}

function AgentInviteSignup() {
  const [token] = useState(inviteFromLink);
  const [stopping] = useState(() => new URLSearchParams(window.location.search).get("stop") === "1");
  const [invite, setInvite] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState({ name: "", agency: "", branch: "", phone: "", email: "", password: "", website: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch(apiUrl(`/api/agent-signup?invite=${encodeURIComponent(token)}`));
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          setLoadError(body.error || "This invite link isn't valid.");
          if (body.optedOut) setStopped(true);
          return;
        }
        setInvite(body);
        if (body.optedOut) setStopped(true);
        setForm((f) => ({ ...f, name: body.name || f.name, email: body.email || f.email }));
      } catch {
        setLoadError("Couldn't load your invite. Check your connection and try again.");
      }
    })();
  }, [token]);

  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await post({ action: "invite_signup", token, ...form });
      if (result.email) setForm((f) => ({ ...f, email: result.email }));
      setConfirming(true);
    } catch (error) {
      setMessage(error.message);
    }
    setBusy(false);
  }

  async function stopEmails() {
    setBusy(true);
    try {
      await post({ action: "invite_opt_out", token });
      setStopped(true);
    } catch (error) {
      setMessage(error.message);
    }
    setBusy(false);
  }

  const shell = (children) => (
    <div className="booking-shell">
      <header className="booking-header">
        <p className="eyebrow">For estate agents</p>
        <h1>{invite?.buyer ? `${invite.buyer} invited you to ViewPal` : "You're invited to ViewPal"}</h1>
        <p className="muted">
          Buyers book viewings straight into your diary. Set your viewing hours once, and see each buyer's position
          before they arrive. Free for {invite?.trialDays || 14} days, no code needed.
        </p>
      </header>
      <section className="card agent-auth">{children}</section>
      <p className="muted agent-auth-foot">
        Already have an account? <a href="/agent">Log in</a>.
        <br />
        <a href="/agents">See how it works for agents</a>.
      </p>
    </div>
  );

  if (stopping) {
    return shell(
      stopped ? (
        <p className="agent-joining" role="status">
          Done. We won't email this address about ViewPal again.
        </p>
      ) : (
        <>
          <h3>Stop emails from ViewPal?</h3>
          <p className="muted">We won't send this address any more invites.</p>
          <button type="button" className="secondary-button" disabled={busy} onClick={stopEmails}>
            Don't email me again
          </button>
          {message && <p className="booking-error">{message}</p>}
        </>
      )
    );
  }

  if (loadError) {
    return shell(
      <>
        <p className="booking-error">{loadError}</p>
        <a className="secondary-button" href="/agent">
          Go to log in
        </a>
      </>
    );
  }

  if (!invite) return shell(<p className="muted">Loading your invite...</p>);

  if (confirming) {
    return shell(
      <CheckYourEmail
        email={form.email.trim()}
        password={form.password}
        next="/agent"
        onBack={() => setConfirming(false)}
      />
    );
  }

  return shell(
    <form className="booking-form" onSubmit={submit}>
      {invite.address && (
        <p className="agent-joining">
          {invite.buyer || "A buyer"} saved <strong>{invite.address}</strong>. Join and their next booking lands in
          your diary.
        </p>
      )}
      <div className="booking-form-grid">
        <label>
          Your name *
          <input required maxLength={100} autoComplete="name" value={form.name} onChange={update("name")} />
        </label>
        <label>
          Agency *
          <input required maxLength={100} autoComplete="organization" value={form.agency} onChange={update("agency")} />
        </label>
        <label>
          Branch
          <input maxLength={100} value={form.branch} onChange={update("branch")} />
        </label>
        <label>
          Phone (shown to buyers who book)
          <input type="tel" maxLength={40} autoComplete="tel" value={form.phone} onChange={update("phone")} />
        </label>
      </div>
      <div className="booking-form-grid">
        <label>
          Work email *
          <input
            required
            type="email"
            autoComplete="email"
            value={form.email}
            onChange={update("email")}
            readOnly={invite.emailLocked}
          />
          {invite.emailLocked && <span className="field-hint">Your invite was sent to this address.</span>}
        </label>
        <label>
          Password *
          <input
            required
            type="password"
            minLength={8}
            maxLength={72}
            autoComplete="new-password"
            value={form.password}
            onChange={update("password")}
          />
        </label>
      </div>
      <input
        className="booking-honeypot"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={form.website}
        onChange={update("website")}
      />
      {message && <p className="booking-error">{message}</p>}
      <button type="submit" className="primary-button" disabled={busy}>
        {busy ? "Please wait..." : "Start free trial"}
      </button>
    </form>
  );
}

export default AgentInviteSignup;
