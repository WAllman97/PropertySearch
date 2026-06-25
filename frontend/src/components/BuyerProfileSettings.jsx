import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function BuyerProfileSettings({ user }) {
  const [profile, setProfile] = useState({
    user_work_address: "",
    partner_work_address: "",
    school_address: "",
    has_school_commute: false,
    commute_mode: "TRANSIT",
  });

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refreshingCommutes, setRefreshingCommutes] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");

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
      });
    }
  }

  async function saveBuyerProfile() {
    setSaving(true);
    setSaved(false);

    const { error } = await supabase.from("buyer_profiles").upsert(
      {
        user_id: user.id,
        ...profile,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "user_id",
      }
    );

    if (error) {
      console.error(error);
      alert("Could not save buyer profile.");
    } else {
      setSaved(true);
    }

    setSaving(false);
  }

  async function refreshAllCommutes() {
    setRefreshingCommutes(true);
    setRefreshMessage("");

    try {
      const response = await fetch("/api/refresh_commutes", {
        method: "POST",
      });

      const text = await response.text();

      let result = {};
      if (text) {
        result = JSON.parse(text);
      }

      if (!response.ok || result.success === false) {
        throw new Error(
          result.error || `Request failed with status ${response.status}`
        );
      }

      setRefreshMessage("Commute refresh complete. Reload the page to see updated commute times.");
    } catch (error) {
      console.error("Error refreshing commutes:", error);
      setRefreshMessage(error.message || "Could not refresh commutes.");
    }

    setRefreshingCommutes(false);
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
          onChange={(e) => updateField("has_school_commute", e.target.checked)}
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

      <div className="settings-button-row">
        <button onClick={saveBuyerProfile} disabled={saving}>
          {saving ? "Saving..." : "Save buyer profile"}
        </button>

        <button
          type="button"
          className="secondary-button"
          onClick={refreshAllCommutes}
          disabled={refreshingCommutes}
        >
          {refreshingCommutes ? "Refreshing..." : "Refresh all commutes"}
        </button>
      </div>

      {saved && <p className="success-message">Buyer profile saved.</p>}
      {refreshMessage && <p className="form-message">{refreshMessage}</p>}
    </div>
  );
}

export default BuyerProfileSettings;