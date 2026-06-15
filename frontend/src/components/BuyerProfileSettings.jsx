import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function BuyerProfileSettings({ user }) {
  const [profile, setProfile] = useState({
    user_work_address: "",
    partner_work_address: "",
    school_address: "",
    has_school_commute: false,
    commute_mode: "TRANSIT",
    email_alerts_enabled: true,
    alert_email: "",
  });

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (user) {
      loadBuyerProfile();
    }
  }, [user]);

  async function loadBuyerProfile() {
    const { data, error } = await supabase
      .from("buyer_profiles")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error(error);
      return;
    }

    if (data) {
      setProfile({
        user_work_address: data.user_work_address || "",
        partner_work_address: data.partner_work_address || "",
        school_address: data.school_address || "",
        has_school_commute: data.has_school_commute || false,
        commute_mode: data.commute_mode || "TRANSIT",
        email_alerts_enabled: data.email_alerts_enabled ?? true,
        alert_email: data.alert_email || user.email || "",
      });
    } else {
      setProfile((prev) => ({
        ...prev,
        alert_email: user.email || "",
      }));
    }
  }

  async function saveBuyerProfile() {
    setSaving(true);
    setSaved(false);

    const { error } = await supabase.from("buyer_profiles").upsert({
      user_id: user.id,
      ...profile,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.error(error);
      alert("Could not save buyer profile.");
    } else {
      setSaved(true);
    }

    setSaving(false);
  }

  function updateField(field, value) {
    setProfile((prev) => ({
      ...prev,
      [field]: value,
    }));
  }

  return (
    <div className="buyer-profile-settings">
      <label>Your workplace</label>
      <input
        type="text"
        placeholder="e.g. Liverpool Street, London"
        value={profile.user_work_address}
        onChange={(e) => updateField("user_work_address", e.target.value)}
      />

      <label>Partner workplace</label>
      <input
        type="text"
        placeholder="e.g. Canary Wharf, London"
        value={profile.partner_work_address}
        onChange={(e) => updateField("partner_work_address", e.target.value)}
      />

      <label>Preferred commute method</label>
      <select
        value={profile.commute_mode}
        onChange={(e) => updateField("commute_mode", e.target.value)}
      >
        <option value="TRANSIT">Public transport</option>
        <option value="DRIVE">Driving</option>
        <option value="WALK">Walking</option>
        <option value="BICYCLE">Cycling</option>
      </select>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={profile.has_school_commute}
          onChange={(e) =>
            updateField("has_school_commute", e.target.checked)
          }
        />
        Include school or nursery commute
      </label>

      {profile.has_school_commute && (
        <>
          <label>School / nursery</label>
          <input
            type="text"
            placeholder="e.g. Wimbledon High School"
            value={profile.school_address}
            onChange={(e) => updateField("school_address", e.target.value)}
          />
        </>
      )}

      <hr />

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={profile.email_alerts_enabled}
          onChange={(e) =>
            updateField("email_alerts_enabled", e.target.checked)
          }
        />
        Email me when new properties are found
      </label>

      {profile.email_alerts_enabled && (
        <>
          <label>Email address for alerts</label>
          <input
            type="email"
            placeholder="e.g. your@email.com"
            value={profile.alert_email}
            onChange={(e) => updateField("alert_email", e.target.value)}
          />
        </>
      )}

      <button onClick={saveBuyerProfile} disabled={saving}>
        {saving ? "Saving..." : "Save buyer profile"}
      </button>

      {saved && <p className="success-message">Buyer profile saved.</p>}
    </div>
  );
}

export default BuyerProfileSettings;