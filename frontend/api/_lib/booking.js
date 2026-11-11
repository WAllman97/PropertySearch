// Shared booking logic: load a buyer's page and work out their free slots.
import { supabaseAdmin } from "./household.js";
import { generateSlots } from "./time.js";

// Viewings already in the app calendar block that time too.
const VIEWING_MINUTES = 45;

export async function loadActivePage(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9-]{3,40}$/.test(slug)) {
    return null;
  }

  const { data: page } = await supabaseAdmin
    .from("booking_pages")
    .select("*")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  return page || null;
}

export async function getFreeSlots(page, now = new Date()) {
  const horizon = new Date(now.getTime() + (page.days_ahead + 1) * 86400000);

  const [{ data: windows }, { data: requests }, { data: viewings }] = await Promise.all([
    supabaseAdmin
      .from("availability_windows")
      .select("weekday, start_time, end_time")
      .eq("user_id", page.user_id),
    supabaseAdmin
      .from("booking_requests")
      .select("starts_at, ends_at, status")
      .eq("user_id", page.user_id)
      .in("status", ["pending", "accepted"])
      .gte("ends_at", now.toISOString())
      .lte("starts_at", horizon.toISOString()),
    // property_notes is shared by the household (no user_id), so every
    // scheduled viewing counts as busy.
    supabaseAdmin
      .from("property_notes")
      .select("viewing_datetime")
      .not("viewing_datetime", "is", null)
      .gte("viewing_datetime", new Date(now.getTime() - 3600000).toISOString())
      .lte("viewing_datetime", horizon.toISOString()),
  ]);

  const busy = [
    ...(requests || []).map((r) => ({ start: new Date(r.starts_at), end: new Date(r.ends_at) })),
    ...(viewings || []).map((v) => {
      const start = new Date(v.viewing_datetime);
      return { start, end: new Date(start.getTime() + VIEWING_MINUTES * 60000) };
    }),
  ];

  return generateSlots({ page, windows: windows || [], busy, now });
}

export function appBaseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${req.headers.host}`;
}
