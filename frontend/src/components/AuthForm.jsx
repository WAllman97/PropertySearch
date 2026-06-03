import { useState } from "react";
import { supabase } from "../lib/supabaseClient";

function AuthForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();

    setLoading(true);
    setMessage("");

    try {
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({
          email,
          password,
        });

        if (error) throw error;

        setMessage(
          "Account created. Check your email for the confirmation link."
        );
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (error) throw error;
      }
    } catch (error) {
      setMessage(error.message);
    }

    setLoading(false);
  }

  return (
    <div className="auth-card">
      <h2>{isSignUp ? "Create Account" : "Log In"}</h2>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Email</label>

          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label>Password</label>

          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        <button
          type="submit"
          className="primary-button"
          disabled={loading}
        >
          {loading
            ? "Please wait..."
            : isSignUp
            ? "Create Account"
            : "Log In"}
        </button>
      </form>

      {message && (
        <p style={{ marginTop: "1rem" }}>
          {message}
        </p>
      )}

      <button
        type="button"
        className="secondary-button"
        onClick={() => setIsSignUp(!isSignUp)}
        style={{ marginTop: "1rem" }}
      >
        {isSignUp
          ? "Already have an account? Log In"
          : "Need an account? Sign Up"}
      </button>
    </div>
  );
}

export default AuthForm;