import { requireHouseholdUser, supabaseAdmin, underRateLimit } from "./_lib/household.js";

const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;

// Each recalculation is up to 8 billable Google Routes calls (4 modes x 2
// people). Cap how many properties one user can recalculate per day; a full
// "Refresh commutes" after an address change fits inside this. The hard
// ceiling on spend should still be a quota on the Google Cloud key.
const MAX_RECALCULATIONS_PER_DAY = 300;

// Keep in sync with backend/core/commute_calculator.py COMMUTE_MODES.
const COMMUTE_MODES = {
  transit: "TRANSIT",
  drive: "DRIVE",
  cycle: "BICYCLE",
  walk: "WALK",
};

// Google refused the key itself (Routes API not enabled, key restricted to
// other APIs or to websites): every further call will fail the same way.
const KEY_REJECTED = /Google Routes API error (401|403)/;

function durationToMinutes(duration) {
  if (!duration) return null;
  const seconds = Number(String(duration).replace("s", ""));
  if (Number.isNaN(seconds)) return null;
  return Math.round(seconds / 60);
}

// buyer_profiles.commute_mode -> column label. Only the preferred mode is
// calculated: it's the only one the app shows, and doing all four cost 4x
// the Google requests. Keep in sync with backend/core/commute_calculator.py.
const PROFILE_MODE_TO_LABEL = {
  TRANSIT: "transit",
  DRIVE: "drive",
  BICYCLE: "cycle",
  WALK: "walk",
};

function selectedModeLabel(profile) {
  return PROFILE_MODE_TO_LABEL[(profile?.commute_mode || "TRANSIT").toUpperCase()] || "transit";
}

function hasCommuteData(property, modeLabel) {
  return ["user", "partner"].some(
    (person) => property[`${person}_${modeLabel}_minutes`] != null
  );
}

// Commutes are still valid if they were calculated after the buyer profile
// (work addresses) last changed. Re-running them would only re-buy the same
// answer from Google.
function commutesAreCurrent(property, profile) {
  if (
    !property.commute_last_checked ||
    !hasCommuteData(property, selectedModeLabel(profile))
  ) {
    return false;
  }

  const checkedAt = new Date(property.commute_last_checked).getTime();
  const profileChangedAt = new Date(profile.updated_at || 0).getTime();

  return checkedAt >= profileChangedAt;
}

function getPropertyAddress(property) {
  return property.address || property.display_address || property.title || null;
}

async function calculateRoute(origin, destination, googleMode) {
  if (!googleApiKey) {
    return { success: false, minutes: null, distanceMeters: null, error: "Missing GOOGLE_MAPS_API_KEY" };
  }

  if (!origin || !destination) {
    return { success: false, minutes: null, distanceMeters: null, error: "Missing origin or destination" };
  }

  const body = {
    origin: { address: origin },
    destination: { address: destination },
    travelMode: googleMode,
  };

  if (googleMode === "DRIVE") {
    body.routingPreference = "TRAFFIC_AWARE";
  }

  try {
    const response = await fetch(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": googleApiKey,
          "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        minutes: null,
        distanceMeters: null,
        error: `Google Routes API error ${response.status}: ${errorText}`,
      };
    }

    const data = await response.json();
    const route = data.routes?.[0];

    if (!route) {
      return { success: false, minutes: null, distanceMeters: null, error: "No route returned" };
    }

    return {
      success: true,
      minutes: durationToMinutes(route.duration),
      distanceMeters: route.distanceMeters ?? null,
      error: null,
    };
  } catch (error) {
    return {
      success: false,
      minutes: null,
      distanceMeters: null,
      error: `Commute calculation failed: ${error.message}`,
    };
  }
}

async function calculateModesForPerson(propertyAddress, destination, personLabel, modeLabels) {
  const payload = {};
  const errors = [];

  for (const modeLabel of modeLabels) {
    const googleMode = COMMUTE_MODES[modeLabel];
    const route = await calculateRoute(propertyAddress, destination, googleMode);

    const minutesCol = `${personLabel}_${modeLabel}_minutes`;
    const distanceCol = `${personLabel}_${modeLabel}_distance_meters`;
    const statusCol = `${personLabel}_${modeLabel}_status`;
    const errorCol = `${personLabel}_${modeLabel}_error`;

    if (route.success) {
      payload[minutesCol] = route.minutes;
      payload[distanceCol] = route.distanceMeters;
      payload[statusCol] = "success";
      payload[errorCol] = null;
    } else {
      payload[statusCol] = "failed";
      payload[errorCol] = route.error;
      errors.push(`${personLabel}_${modeLabel}: ${route.error}`);
    }
  }

  return { payload, errors };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { propertyId, force } = req.body || {};

    if (!propertyId) {
      return res.status(400).json({ error: "Missing propertyId" });
    }

    const user = await requireHouseholdUser(req, res);
    if (!user) return;

    const { data: property, error: propertyError } = await supabaseAdmin
      .from("properties")
      .select("*")
      .eq("id", propertyId)
      .single();

    if (propertyError || !property) {
      return res.status(404).json({ error: "Property not found" });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("buyer_profiles")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: "Buyer profile not found" });
    }

    if (!force && commutesAreCurrent(property, profile)) {
      return res.status(200).json({ success: true, skipped: true, property });
    }

    const propertyAddress = getPropertyAddress(property);

    if (!propertyAddress) {
      return res.status(400).json({ error: "Property has no usable address" });
    }

    if (
      !(await underRateLimit(
        user.id,
        "calculate_commute",
        MAX_RECALCULATIONS_PER_DAY,
        24 * 60
      ))
    ) {
      return res.status(429).json({
        error: `Commute limit reached (${MAX_RECALCULATIONS_PER_DAY} per day). Try again tomorrow.`,
      });
    }

    const modeLabels = [selectedModeLabel(profile)];

    const updatePayload = {
      commute_last_checked: new Date().toISOString(),
      commute_status: "success",
      commute_error: null,
    };

    const allErrors = [];

    if (profile.user_work_address) {
      const { payload, errors } = await calculateModesForPerson(
        propertyAddress,
        profile.user_work_address,
        "user",
        modeLabels
      );
      Object.assign(updatePayload, payload);
      allErrors.push(...errors);
    }

    // If the first person's call showed every call will fail (quota or key),
    // don't spend another request on the partner.
    const halted = allErrors.some((e) => /Google Routes API error 429/.test(e) || KEY_REJECTED.test(e));

    if (profile.partner_work_address && !halted) {
      const { payload, errors } = await calculateModesForPerson(
        propertyAddress,
        profile.partner_work_address,
        "partner",
        modeLabels
      );
      Object.assign(updatePayload, payload);
      allErrors.push(...errors);
    }

    if (allErrors.length > 0) {
      updatePayload.commute_status = "partial_failed";
      updatePayload.commute_error = allErrors.join(" | ").slice(0, 2000);
    }

    const { data: updatedProperty, error: updateError } = await supabaseAdmin
      .from("properties")
      .update(updatePayload)
      .eq("id", propertyId)
      .select("*")
      .single();

    if (updateError) {
      console.error(updateError);
      return res.status(500).json({ error: "Could not update property" });
    }

    // Google's daily quota is used up, or it rejected the key: tell the
    // client to stop its refresh loop rather than spend the next N requests
    // on guaranteed failures (rejected calls still count against the quota).
    if (allErrors.some((e) => e.includes("Google Routes API error 429"))) {
      return res.status(429).json({
        error: "Google's daily commute quota is used up. Try again tomorrow.",
        property: updatedProperty,
      });
    }

    if (allErrors.some((e) => KEY_REJECTED.test(e))) {
      return res.status(503).json({
        error:
          "Google rejected the commute API key. Enable the Routes API for GOOGLE_MAPS_API_KEY and remove any website restriction.",
        property: updatedProperty,
      });
    }

    return res.status(200).json({
      success: true,
      property: updatedProperty,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
}
