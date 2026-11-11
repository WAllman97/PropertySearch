import { useState } from "react";
import { supabase } from "../lib/supabaseClient";

const MIN_LENGTH = 8;

// Shown when the user arrives from a password-reset email. Supabase has
// already signed them in with a short-lived recovery session; this sets the
// new password on that session.
function SetNewPasswordForm({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    setMessage("");

    if (password.length < MIN_LENGTH) {
      setMessage(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }

    if (password !== confirm) {
      setMessage("The two passwords don't match.");
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (error) {
      setMessage(
        /expired|invalid|missing/i.test(error.message)
          ? "This reset link has expired. Request a new one from the log in page."
          : error.message
      );
      return;
    }

    onDone();
  }

  return (
    <div className="auth-card">
      <h2>Set a new password</h2>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="confirm-password">Confirm new password</label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_LENGTH}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </div>

        <button type="submit" className="primary-button" disabled={loading}>
          {loading ? "Saving..." : "Save new password"}
        </button>
      </form>

      {message && <p className="auth-message">{message}</p>}
    </div>
  );
}

export default SetNewPasswordForm;
