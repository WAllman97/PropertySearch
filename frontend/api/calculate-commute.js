import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;

const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

// Keep in sync with backend/core/commute_calculator.py COMMUTE_MODES.
const COMMUTE_MODES = {
  transit: "TRANSIT",
  drive: "DRIVE",
  cycle: "BICYCLE",
  walk: "WALK",
};

function durationToMinutes(duration) {
  if (!duration) return null;
  const seconds = Number(String(duration).replace("s", ""));
  if (Number.isNaN(seconds)) return null;
  return Math.round(seconds / 60);
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

async function calculateAllModesForPerson(propertyAddress, destination, personLabel) {
  const payload = {};
  const errors = [];

  for (const [modeLabel, googleMode] of Object.entries(COMMUTE_MODES)) {
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
    const { propertyId } = req.body || {};

    if (!propertyId) {
      return res.status(400).json({ error: "Missing propertyId" });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Missing auth token" });
    }

    const userClient = createClient(supabaseUrl, process.env.VITE_SUPABASE_ANON_KEY);

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser(token);

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid user token" });
    }

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

    const propertyAddress = getPropertyAddress(property);

    if (!propertyAddress) {
      return res.status(400).json({ error: "Property has no usable address" });
    }

    const updatePayload = {
      commute_last_checked: new Date().toISOString(),
      commute_status: "success",
      commute_error: null,
    };

    const allErrors = [];

    if (profile.user_work_address) {
      const { payload, errors } = await calculateAllModesForPerson(
        propertyAddress,
        profile.user_work_address,
        "user"
      );
      Object.assign(updatePayload, payload);
      allErrors.push(...errors);
    }

    if (profile.partner_work_address) {
      const { payload, errors } = await calculateAllModesForPerson(
        propertyAddress,
        profile.partner_work_address,
        "partner"
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

    return res.status(200).json({
      success: true,
      property: updatedProperty,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
}
