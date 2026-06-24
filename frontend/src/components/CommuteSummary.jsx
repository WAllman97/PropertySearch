import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import "./CommuteSummary.css";

function getCommuteIcon(mode) {
  const icons = {
    transit: "🚇",
    drive: "🚗",
    walk: "🚶",
    cycle: "🚲",
  };

  return icons[mode] || "🚇";
}

function getModeLabel(mode) {
  const labels = {
    transit: "Public transport",
    drive: "Driving",
    walk: "Walking",
    cycle: "Cycling",
  };

  return labels[mode] || "Public transport";
}

function getSelectedMode(profile) {
  const mode = profile?.commute_mode || "TRANSIT";

  if (mode === "DRIVE") return "drive";
  if (mode === "WALK") return "walk";
  if (mode === "BICYCLE") return "cycle";

  return "transit";
}

function CommuteSummary({ property }) {
  const [profile, setProfile] = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(true);

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

  const selectedMode = getSelectedMode(profile);

  const userMinutes = property[`user_${selectedMode}_minutes`];
  const partnerMinutes = property[`partner_${selectedMode}_minutes`];

  const hasUserCommute = Boolean(userMinutes);
  const hasPartnerCommute = Boolean(partnerMinutes);
  const hasAnyCommute = hasUserCommute || hasPartnerCommute;

  return (
    <div className="commute-summary">
      {hasAnyCommute ? (
        <>
          <div className="commute-results">
            {hasUserCommute && (
              <span>
                {getCommuteIcon(selectedMode)} You: {userMinutes} mins
              </span>
            )}

            {hasPartnerCommute && (
              <span>
                {getCommuteIcon(selectedMode)} Partner: {partnerMinutes} mins
              </span>
            )}
          </div>

          <p className="commute-message">{getModeLabel(selectedMode)}</p>
        </>
      ) : (
        <p className="commute-empty">No commute calculated yet.</p>
      )}
    </div>
  );
}

export default CommuteSummary;