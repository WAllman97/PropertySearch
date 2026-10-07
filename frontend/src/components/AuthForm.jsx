import { useState } from "react";
import { supabase } from "../lib/supabaseClient";

// Sign-up is deliberately not offered here: any signed-in account can send
// share emails from our domain and spend Google Maps quota. New users should
// be invited from the Supabase dashboard (Authentication -> Users -> Invite).
function AuthForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function handleSubmit(event) {
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

  return (
    <div className="auth-card">
      <h2>Log In</h2>

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
          {loading ? "Please wait..." : "Log In"}
        </button>
      </form>

      {message && (
        <p style={{ marginTop: "1rem" }}>
          {message}
        </p>
      )}
    </div>
  );
}

export default AuthForm;
