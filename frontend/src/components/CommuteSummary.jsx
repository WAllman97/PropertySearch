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

function getModeLabel(mode) {
  const labels = {
    TRANSIT: "Public transport",
    DRIVE: "Driving",
    WALK: "Walking",
    BICYCLE: "Cycling",
  };

  return labels[mode] || "Public transport";
}

function CommuteSummary({ property }) {
  const [profile, setProfile] = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(true);

  const hasUserCommute = Boolean(property.user_commute_minutes);
  const hasPartnerCommute = Boolean(property.partner_commute_minutes);
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
    } else {
      setProfile(data);
    }

    setLoadingProfile(false);
  }

  if (loadingProfile) {
    return null;
  }

  return (
    <div className="commute-summary">
      {hasAnyCommute ? (
        <>
          <div className="commute-results">
            {hasUserCommute && (
              <span>
                {getCommuteIcon(property.commute_mode || profile?.commute_mode)} You:{" "}
                {property.user_commute_minutes} mins
              </span>
            )}

            {hasPartnerCommute && (
              <span>
                {getCommuteIcon(property.commute_mode || profile?.commute_mode)} Partner:{" "}
                {property.partner_commute_minutes} mins
              </span>
            )}
          </div>

          <p className="commute-message">
            {getModeLabel(property.commute_mode || profile?.commute_mode)}
          </p>
        </>
      ) : (
        <p className="commute-empty">No commute calculated yet.</p>
      )}
    </div>
  );
}

export default CommuteSummary;
