import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import "./CommuteSummary.css";

function getCommuteIcon(mode) {
  const icons = {
    TRANSIT: "🚇",
    DRIVE: "🚗",
    WALK: "🚶",
    BICYCLE: "🚲",
  };

  return icons[mode] || "🚇";
}

function CommuteSummary({ property, onCommuteSaved }) {
  const [profile, setProfile] = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [calculating, setCalculating] = useState(false);
  const [message, setMessage] = useState("");

  const hasUserCommute = Boolean(property.commute_user_minutes);
  const hasPartnerCommute = Boolean(property.commute_partner_minutes);
  const hasAnyCommute = hasUserCommute || hasPartnerCommute;

  useEffect(() => {
    loadBuyerProfile();
  }, []);

  async function loadBuyerProfile() {
    setLoadingProfile(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setLoadingProfile(false);
      return;
    }

    const { data, error } = await supabase
      .from("buyer_profiles")
      .select("user_work_address, partner_work_address, commute_mode")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error("Error loading buyer profile:", error);
      setMessage("Could not load commute settings.");
    } else {
      setProfile(data);
    }

    setLoadingProfile(false);
  }

  async function calculateSingleCommute(destination) {
    const response = await fetch("/api/commute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        origin: property.address,
        destination,
        mode: profile?.commute_mode || "TRANSIT",
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Could not calculate commute");
    }

    return result.duration_minutes;
  }

  async function calculateCommutes() {
    if (!property?.id || !property?.address) {
      setMessage("This property needs an address before commute can be calculated.");
      return;
    }

    if (!profile?.user_work_address && !profile?.partner_work_address) {
      setMessage("Add at least one workplace in Settings first.");
      return;
    }

    setCalculating(true);
    setMessage("");

    try {
      const updates = {};

      if (profile.user_work_address) {
        updates.commute_user_minutes = await calculateSingleCommute(
          profile.user_work_address
        );
      }

      if (profile.partner_work_address) {
        updates.commute_partner_minutes = await calculateSingleCommute(
          profile.partner_work_address
        );
      }

      const { data, error } = await supabase
        .from("properties")
        .update(updates)
        .eq("id", property.id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      setMessage("Commute saved.");

      if (onCommuteSaved) {
        onCommuteSaved(data);
      }
    } catch (error) {
      console.error("Error calculating commute:", error);
      setMessage(error.message || "Could not calculate commute.");
    }

    setCalculating(false);
  }

  if (loadingProfile) {
    return null;
  }

  return (
    <div className="commute-summary">
      {hasAnyCommute ? (
        <div className="commute-results">
          {hasUserCommute && (
            <span>
              {getCommuteIcon(profile?.commute_mode)} You: {property.commute_user_minutes} mins
            </span>
          )}

          {hasPartnerCommute && (
            <span>
              {getCommuteIcon(profile?.commute_mode)} Partner: {property.commute_partner_minutes} mins
            </span>
          )}
        </div>
      ) : (
        <p className="commute-empty">No commute calculated yet.</p>
      )}

      <button
        type="button"
        className="secondary-button commute-button"
        onClick={(event) => {
          event.stopPropagation();
          calculateCommutes();
        }}
        disabled={calculating}
      >
        {calculating ? "Calculating..." : hasAnyCommute ? "Refresh commute" : "Calculate commute"}
      </button>

      {message && <p className="commute-message">{message}</p>}
    </div>
  );
}

export default CommuteSummary;
