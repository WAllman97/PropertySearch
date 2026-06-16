export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "Missing GOOGLE_MAPS_API_KEY" });
  }

  const { origin, destination, mode } = req.body || {};

  if (!origin || !destination) {
    return res.status(400).json({ error: "Origin and destination are required" });
  }

  const googleModeMap = {
    TRANSIT: "transit",
    DRIVE: "driving",
    WALK: "walking",
    BICYCLE: "bicycling",
  };

  const googleMode = googleModeMap[mode] || "transit";

  const params = new URLSearchParams({
    origins: origin,
    destinations: destination,
    mode: googleMode,
    units: "imperial",
    key: apiKey,
  });

  if (googleMode === "transit") {
    params.set("departure_time", "now");
  }

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`
    );

    const data = await response.json();

    if (!response.ok || data.status !== "OK") {
      return res.status(502).json({
        error: "Google Maps request failed",
        details: data.error_message || data.status,
      });
    }

    const element = data.rows?.[0]?.elements?.[0];

    if (!element || element.status !== "OK") {
      return res.status(404).json({
        error: "Could not calculate commute",
        details: element?.status || "No route found",
      });
    }

    const duration = element.duration_in_traffic || element.duration;

    return res.status(200).json({
      distance_text: element.distance?.text || "",
      duration_text: duration?.text || "",
      duration_minutes: duration?.value ? Math.round(duration.value / 60) : null,
      mode: googleMode,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected commute calculation error",
      details: error.message,
    });
  }
}
