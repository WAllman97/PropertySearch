import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { apiUrl, siteUrl } from "../lib/platform";
import { CheckYourEmail } from "./ConfirmEmail";

// Has anyone logged in on this device before? Then open on Log In; a new
// person (most App Store downloads) gets Create account first. Set by App.jsx
// once a session exists.
export const SEEN_ACCOUNT_KEY = "ps:hasLoggedIn";

function seenAccountHere() {
  try {
    return localStorage.getItem(SEEN_ACCOUNT_KEY) === "1";
  } catch {
    return false;
  }
}

// Log in, reset a password, or sign up. Sign-up goes through
// /api/buyer-signup, which creates a new household, or joins the household
// whose invite link (/join/<code>) brought them here.
function AuthForm({ invite = null }) {
  // "login" | "forgot" | "signup" | "check" (confirm your email) | "unconfirmed"
  const [mode, setMode] = useState(() => (invite || !seenAccountHere() ? "signup" : "login"));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  // { householdName } once the invite is checked, or { error }.
  const [inviteInfo, setInviteInfo] = useState(null);

  useEffect(() => {
    if (!invite) return;
    fetch(apiUrl(`/api/buyer-signup?invite=${encodeURIComponent(invite)}`))
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        setInviteInfo(response.ok ? body : { error: body.error || "This invite link isn't valid." });
      })
      .catch(() => setInviteInfo({ error: "Couldn't check the invite link. Please try again." }));
  }, [invite]);

  const joining = Boolean(invite && inviteInfo && !inviteInfo.error);

  function switchMode(next) {
    setMode(next);
    setMessage("");
    setPassword("");
  }

  async function handleSignup(event) {
    event.preventDefault();

    setLoading(true);
    setMessage("");

    try {
      const response = await fetch(apiUrl("/api/buyer-signup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          website,
          invite: joining ? invite : undefined,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not create your account");

      // Drop /join/<code> so a refresh doesn't offer to sign up again.
      if (invite) window.history.replaceState(null, "", "/");

      // The account opens once they tap the link we've emailed.
      if (body.confirmEmail) {
        setMode("check");
        setLoading(false);
        return;
      }
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (error) {
      setMessage(error.message);
      setLoading(false);
    }
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

      if (error?.code === "email_not_confirmed") {
        setMode("unconfirmed");
      } else if (error) {
        throw error;
      }
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
    // The email template (docs/email-templates/reset-password.html) links to
    // this address plus the one-time code, straight to our site, so the reset
    // opens and finishes in the iPhone app (views/ResetPasswordPage.jsx).
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteUrl}/reset/buyer`,
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

  if (mode === "check" || mode === "unconfirmed") {
    return (
      <div className="auth-card">
        <CheckYourEmail
          email={email.trim()}
          password={password}
          afterLogin={mode === "unconfirmed"}
          onBack={() => switchMode(mode === "check" ? "signup" : "login")}
        />
      </div>
    );
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

  if (mode === "signup") {
    return (
      <div className="auth-card">
        <h2>{joining ? `Join ${inviteInfo.householdName}` : "Create an account"}</h2>
        <p className="muted">
          {joining
            ? "You'll share their property list, viewings calendar and notes."
            : "Save homes from any portal, compare commutes, book viewings and keep notes in one place. Invite your partner once you're in."}
        </p>
        {invite && inviteInfo?.error && (
          <p className="booking-error">
            {inviteInfo.error} You can still sign up with your own list below.
          </p>
        )}

        <form onSubmit={handleSignup}>
          <div className="form-group">
            <label htmlFor="signup-name">Your name</label>
            <input
              id="signup-name"
              autoComplete="name"
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="signup-email">Email</label>
            <input
              id="signup-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="signup-password">Password</label>
            <input
              id="signup-password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={72}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>

          <input
            className="booking-honeypot"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
          />

          <button type="submit" className="primary-button" disabled={loading}>
            {loading ? "Creating your account..." : joining ? "Join" : "Create account"}
          </button>
        </form>

        {message && <p className="auth-message">{message}</p>}

        <p className="muted auth-agent-link">
          By signing up you agree to our <a href="/privacy">privacy policy</a>.
        </p>

        <button type="button" className="link-button" onClick={() => switchMode("login")}>
          Already have an account? Log in
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

      <div className="auth-links">
        <button type="button" className="link-button" onClick={() => switchMode("forgot")}>
          Forgot password?
        </button>
        <button type="button" className="link-button" onClick={() => switchMode("signup")}>
          New here? Create an account
        </button>
      </div>

      {/* In the phone app there's no address bar, so agents need a way in. */}
      <p className="muted auth-agent-link">
        Estate agent? <a href="/agent">Sign in or sign up here</a> ·{" "}
        <a href="/privacy">Privacy</a>
      </p>
    </div>
  );
}

export default AuthForm;
