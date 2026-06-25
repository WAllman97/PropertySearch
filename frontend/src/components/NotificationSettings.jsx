import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function NotificationSettings({ user }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [dailyEmailEnabled, setDailyEmailEnabled] = useState(true);
  const [emailFrequency, setEmailFrequency] = useState("daily");
  const [extraRecipientsText, setExtraRecipientsText] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    loadSettings();
  }, [user]);

  async function loadSettings() {
    if (!user) return;

    setLoading(true);

    const { data, error } = await supabase
      .from("notification_settings")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error(error);
      setMessage(error.message);
      setLoading(false);
      return;
    }

    if (data) {
      setDailyEmailEnabled(data.daily_email_enabled ?? true);
      setEmailFrequency(data.email_frequency || "daily");
      setExtraRecipientsText((data.extra_recipients || []).join(", "));
    }

    setLoading(false);
  }

  async function saveSettings(event) {
    event.preventDefault();

    setSaving(true);
    setMessage("");

    const extraRecipients = extraRecipientsText
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean);

    const payload = {
      user_id: user.id,
      daily_email_enabled: dailyEmailEnabled,
      email_frequency: emailFrequency,
      extra_recipients: dailyEmailEnabled ? extraRecipients : [],
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("notification_settings")
      .upsert(payload, { onConflict: "user_id" });

    if (error) {
      console.error(error);
      setMessage(error.message);
    } else {
      setMessage("Notification settings saved.");
    }

    setSaving(false);
  }

  if (loading) {
    return <p>Loading notification settings...</p>;
  }

  return (
    <form className="settings-form" onSubmit={saveSettings}>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={dailyEmailEnabled}
          onChange={(event) => setDailyEmailEnabled(event.target.checked)}
        />
        Receive property alert emails
      </label>

      {dailyEmailEnabled && (
        <>
          <label>
            Email frequency
            <select
              value={emailFrequency}
              onChange={(event) => setEmailFrequency(event.target.value)}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>

          <label>
            Primary recipient
            <input type="email" value={user.email || ""} disabled />
          </label>

          <label>
            Additional recipients
            <input
              type="text"
              value={extraRecipientsText}
              onChange={(event) => setExtraRecipientsText(event.target.value)}
              placeholder="partner@email.com, another@email.com"
            />
          </label>
        </>
      )}

      <button type="submit" className="primary-button" disabled={saving}>
        {saving ? "Saving..." : "Save Notification Settings"}
      </button>

      {message && <p className="form-message">{message}</p>}
    </form>
  );
}

export default NotificationSettings;