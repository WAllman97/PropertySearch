import { useEffect, useState } from "react";
import { arrivedFromPasswordReset, supabase } from "../lib/supabaseClient";
import SetNewPasswordForm from "../components/SetNewPasswordForm";

// /reset/buyer?token_hash=...&type=recovery (or /reset/agent): the link in the
// password-reset email (docs/email-templates/reset-password.html). It points
// straight at our site rather than through Supabase's redirect, so on an
// iPhone it opens the app (universal links), and the whole reset happens
// there. We verify the one-time code here, then ask for the new password.

const verifying = {};

function ResetPasswordPage({ who }) {
  const [status, setStatus] = useState("checking"); // checking | ready | done | failed
  const next = who === "agent" ? "/agent" : "/";

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token_hash");
    // Keep the code out of history and the address bar.
    window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      // The older template: Supabase verified the link and sent us here with
      // the session in the address. The client has already picked it up.
      if (arrivedFromPasswordReset) {
        supabase.auth.getSession().then(({ data }) => setStatus(data.session ? "ready" : "failed"));
      } else {
        setStatus("failed");
      }
      return;
    }
    (async () => {
      // One check per code, even if React runs this twice.
      verifying[token] ||= supabase.auth.verifyOtp({ token_hash: token, type: "recovery" });
      const { error } = await verifying[token];
      setStatus(error ? "failed" : "ready");
    })();
  }, []);

  return (
    <div className="booking-shell">
      {status === "checking" && (
        <section className="card">
          <p className="muted">Checking your reset link...</p>
        </section>
      )}
      {status === "ready" && (
        <SetNewPasswordForm
          onDone={() => {
            setStatus("done");
            setTimeout(() => window.location.replace(next), 1200);
          }}
        />
      )}
      {status === "done" && (
        <section className="card check-email">
          <div className="check-email-icon" aria-hidden="true">
            ✅
          </div>
          <h3>Password changed</h3>
          <p>You're signed in. Taking you in...</p>
        </section>
      )}
      {status === "failed" && (
        <section className="card check-email">
          <h3>That link has expired or was already used</h3>
          <p>Reset links work once and last an hour. Ask for a new one from the log-in page.</p>
          <a className="primary-button" href={next}>
            Go to log in
          </a>
        </section>
      )}
    </div>
  );
}

export default ResetPasswordPage;
