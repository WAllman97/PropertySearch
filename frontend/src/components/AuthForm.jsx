import { useState } from "react";
import { supabase } from "../lib/supabaseClient";

// Sign-up is deliberately not offered here: any signed-in account can send
// share emails from our domain and spend Google Maps quota. New users should
// be invited from the Supabase dashboard (Authentication -> Users -> Invite).
function AuthForm() {
  const [mode, setMode] = useState("login"); // "login" | "forgot"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  function switchMode(next) {
    setMode(next);
    setMessage("");
    setPassword("");
  }

  async function handleLogin(event) {
    event.preventDefault();

    setLoading(true);
    setMessage("");

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;
    } catch (error) {
      setMessage(error.message);
    }

    setLoading(false);
  }

  async function handleForgot(event) {
    event.preventDefault();

    setLoading(true);
    setMessage("");

    // The link in the email brings the user back here; App.jsx sees the
    // PASSWORD_RECOVERY event and shows the "set a new password" screen.
    // This URL must be listed under Authentication -> URL Configuration ->
    // Redirect URLs in Supabase, otherwise the Site URL is used instead.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });

    setLoading(false);

    if (error) {
      setMessage(
        error.status === 429
          ? "Too many attempts. Please wait a minute and try again."
          : error.message
      );
      return;
    }

    // Same message whether or not the account exists, so the form can't be
    // used to find out who has an account.
    setMessage("If that email has an account, a reset link is on its way. Check your inbox.");
  }

  if (mode === "forgot") {
    return (
      <div className="auth-card">
        <h2>Reset your password</h2>
        <p className="muted">
          Enter your email and we'll send you a link to set a new password.
        </p>

        <form onSubmit={handleForgot}>
          <div className="form-group">
            <label htmlFor="reset-email">Email</label>
            <input
              id="reset-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>

          <button type="submit" className="primary-button" disabled={loading}>
            {loading ? "Sending..." : "Send reset link"}
          </button>
        </form>

        {message && <p className="auth-message">{message}</p>}

        <button type="button" className="link-button" onClick={() => switchMode("login")}>
          Back to log in
        </button>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h2>Log In</h2>

      <form onSubmit={handleLogin}>
        <div className="form-group">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        <button type="submit" className="primary-button" disabled={loading}>
          {loading ? "Please wait..." : "Log In"}
        </button>
      </form>

      {message && <p className="auth-message">{message}</p>}

      <button type="button" className="link-button" onClick={() => switchMode("forgot")}>
        Forgot password?
      </button>
    </div>
  );
}

export default AuthForm;
