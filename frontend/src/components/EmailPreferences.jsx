import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// Which emails you get (migration 028). The same switches the unsubscribe
// link in each email flips. Bookings, cancellations and reminders always come.
const KINDS = [
  { key: "matches", label: "New homes agents send you" },
  { key: "price_drops", label: "Price cuts on homes you've saved" },
];

function EmailPreferences({ user }) {
  const [prefs, setPrefs] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase
      .from("email_preferences")
      .select("matches, price_drops")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data, error: loadError }) => {
        if (loadError) {
          setError("Email settings aren't switched on yet (database migration 028).");
          return;
        }
        setPrefs(data || { matches: true, price_drops: true });
      });
  }, [user.id]);

  async function toggle(key) {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    const { error: saveError } = await supabase
      .from("email_preferences")
      .upsert({ user_id: user.id, ...next, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (saveError) {
      setPrefs(prefs);
      setError("Couldn't save that. Please try again.");
    }
  }

  if (error) return <p className="muted">{error}</p>;
  if (!prefs) return <p className="muted">Loading...</p>;

  return (
    <div className="email-preferences">
      {KINDS.map((k) => (
        <label key={k.key} className="agent-auto">
          <input type="checkbox" checked={prefs[k.key]} onChange={() => toggle(k.key)} />
          {k.label}
        </label>
      ))}
      <p className="muted">
        Viewing confirmations, cancellations and reminders always come, so you don't miss one.
      </p>
    </div>
  );
}

export default EmailPreferences;
