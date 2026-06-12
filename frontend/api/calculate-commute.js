import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;

const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

function durationToMinutes(duration) {
  if (!duration) return null;
  const seconds = Number(duration.replace("s", ""));
  return Math.round(seconds / 60);
}

function getPropertyAddress(property) {
  return [
    property.address,
    property.display_address,
    property.location,
    property.postcode,
  ]
    .filter(Boolean)
    .join(", ");
}

async function calculateRoute(origin, destination, mode) {
  if (!origin || !destination) return null;

  const response = await fetch(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": googleApiKey,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
      },
      body: JSON.stringify({
        origin: {
          address: origin,
        },
        destination: {
          address: destination,
        },
        travelMode: mode || "TRANSIT",
        routingPreference: mode === "DRIVE" ? "TRAFFIC_AWARE" : undefined,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Google Routes API error:", errorText);
    return null;
  }

  const data = await response.json();
  const route = data.routes?.[0];

  if (!route) return null;

  return {
    minutes: durationToMinutes(route.duration),
    distanceMeters: route.distanceMeters || null,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { propertyId } = req.body;

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
    const mode = profile.commute_mode || "TRANSIT";

    const userRoute = await calculateRoute(
      propertyAddress,
      profile.user_work_address,
      mode
    );

    const partnerRoute = await calculateRoute(
      propertyAddress,
      profile.partner_work_address,
      mode
    );

    const schoolRoute = profile.has_school_commute
      ? await calculateRoute(propertyAddress, profile.school_address, mode)
      : null;

    const updatePayload = {
      user_commute_minutes: userRoute?.minutes || null,
      partner_commute_minutes: partnerRoute?.minutes || null,
      school_commute_minutes: schoolRoute?.minutes || null,
      commute_mode: mode,
      commute_last_checked: new Date().toISOString(),
    };

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