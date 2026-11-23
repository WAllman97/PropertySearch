import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { apiUrl } from "../lib/platform";

// Confirming a new account's email (api/_lib/confirm-email.js): the "check
// your inbox" panel after sign-up, the "send it again" button for someone
// who tries to log in before confirming, and the /confirm page the email's
// link opens.

export async function resendConfirmation({ email, password, next = "/" }) {
  const response = await fetch(apiUrl("/api/buyer-signup"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resend_confirmation", email: email.trim(), password, next }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Could not send the email. Please try again.");
  return body;
}

// Shown after sign-up, and after a log-in attempt with an unconfirmed email.
export function CheckYourEmail({ email, password, next = "/", afterLogin = false, onBack }) {
  const [state, setState] = useState("idle"); // idle | sending | sent | error
  const [note, setNote] = useState("");
  const [checking, setChecking] = useState(false);

  // Try logging in with the details they just typed. Works as soon as the
  // email is confirmed, wherever they tapped the link (another browser, a
  // laptop), and signing in moves the app on by itself. -> true if in.
  async function tryLogIn() {
    if (!email || !password) return false;
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    return !error;
  }

  // Check when they come back to this screen (after tapping the link in
  // their mail app) and every 15 seconds for 10 minutes. Gentle enough for
  // Supabase's log-in rate limit.
  useEffect(() => {
    if (!password) return undefined;
    let stopped = false;
    const check = () => {
      if (!stopped && document.visibilityState === "visible") tryLogIn();
    };
    const timer = setInterval(check, 15000);
    const stop = setTimeout(() => clearInterval(timer), 10 * 60 * 1000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(stop);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
    // Only for these details.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, password]);

  async function continueNow() {
    setChecking(true);
    setNote("");
    const ok = await tryLogIn();
    setChecking(false);
    if (!ok) {
      setState("idle");
      setNote("Not confirmed yet. Tap the link in the email, then come back here.");
    }
  }

  async function resend() {
    setState("sending");
    try {
      const result = await resendConfirmation({ email, password, next });
      if (result.alreadyConfirmed) {
        setNote("Your email is already confirmed. Log in.");
      } else {
        setNote(`Sent. Check ${email}, including your spam or junk folder.`);
      }
      setState("sent");
    } catch (error) {
      setNote(error.message);
      setState("error");
    }
  }

  return (
    <div className="check-email" role="status">
      <div className="check-email-icon" aria-hidden="true">✉️</div>
      <h3>{afterLogin ? "Confirm your email first" : "Check your inbox"}</h3>
      <p>
        {afterLogin ? "We sent a link to " : "We've sent a link to "}
        <strong>{email}</strong>. Tap it to confirm your email and{" "}
        {afterLogin ? "you'll be logged in." : "finish setting up your account."}
      </p>
      <p className="muted">
        Once you've tapped it, this screen moves on by itself. The link expires in an hour. Can't
        find it? Check your spam or junk folder.
      </p>
      <div className="check-email-actions">
        {password && (
          <button type="button" className="primary-button" disabled={checking} onClick={continueNow}>
            {checking ? "Checking..." : "I've confirmed, continue"}
          </button>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={state === "sending" || state === "sent"}
          onClick={resend}
        >
          {state === "sending" ? "Sending..." : state === "sent" ? "Sent" : "Send the link again"}
        </button>
        {onBack && (
          <button type="button" className="link-button" onClick={onBack}>
            {afterLogin ? "Back to log in" : "Wrong email? Start again"}
          </button>
        )}
      </div>
      {note && <p className={state === "error" ? "booking-error" : "muted"}>{note}</p>}
    </div>
  );
}

const verifying = {};

// /confirm?token=...&next=/agent : the link in the confirmation email.
export function ConfirmEmailPage() {
  const [status, setStatus] = useState("checking"); // checking | done | failed
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next") === "/agent" ? "/agent" : "/";

  useEffect(() => {
    const token = params.get("token");
    // Keep the token out of history and the address bar.
    window.history.replaceState(null, "", "/confirm");
    if (!token) {
      setStatus("failed");
      return;
    }
    (async () => {
      // One check per token, even if React runs this effect twice.
      verifying[token] ||= supabase.auth.verifyOtp({ token_hash: token, type: "signup" });
      const { error } = await verifying[token];
      if (error) {
        setStatus("failed");
        return;
      }
      setStatus("done");
      setTimeout(() => window.location.replace(next), 1200);
    })();
    // Runs once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="booking-shell">
      <section className="card check-email">
        {status === "checking" && <p className="muted">Confirming your email...</p>}
        {status === "done" && (
          <>
            <div className="check-email-icon" aria-hidden="true">✅</div>
            <h3>Email confirmed</h3>
            <p>You're all set. Taking you in...</p>
          </>
        )}
        {status === "failed" && (
          <>
            <h3>That link has expired or was already used</h3>
            <p>
              If you've already confirmed, just log in. Otherwise log in with your email and
              password and we'll offer to send a new link.
            </p>
            <a className="primary-button" href={next}>
              Go to log in
            </a>
          </>
        )}
      </section>
    </div>
  );
}
