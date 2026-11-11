// Shared auth for the API routes. Files under api/ starting with "_" are not
// deployed as routes by Vercel.
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

// Verifies the caller's Supabase session AND that they are on the household
// allow-list (household_members, see backend/migrations/002). A valid login
// alone isn't enough: these routes spend money (Google Routes) and send email
// from our domain, so a stranger who signs up must not be able to call them.
//
// Returns the user, or sends the error response and returns null.
export async function requireHouseholdUser(req, res) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    res.status(401).json({ error: "Missing auth token" });
    return null;
  }

  const {
    data: { user },
    error: userError,
  } = await supabaseAdmin.auth.getUser(token);

  if (userError || !user) {
    console.error("Token verification failed:", userError?.status, userError?.message);
    res.status(401).json({ error: "Invalid user token" });
    return null;
  }

  const { data: member, error: memberError } = await supabaseAdmin
    .from("household_members")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (memberError) {
    console.error("household_members lookup failed:", memberError);
    res.status(500).json({ error: "Could not verify access" });
    return null;
  }

  if (!member) {
    res.status(403).json({ error: "This account doesn't have access" });
    return null;
  }

  return user;
}

// Fixed-window rate limit backed by the api_usage table (migration 003).
// Serverless instances don't share memory, so this has to live in the DB.
// Fails closed: if the count can't be read, the request is refused.
export async function underRateLimit(userId, action, maxPerWindow, windowMinutes) {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  const { count, error } = await supabaseAdmin
    .from("api_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("action", action)
    .gte("created_at", since);

  if (error) {
    console.error("api_usage lookup failed:", error);
    return false;
  }

  if (count >= maxPerWindow) {
    return false;
  }

  const { error: insertError } = await supabaseAdmin
    .from("api_usage")
    .insert({ user_id: userId, action });

  if (insertError) {
    console.error("api_usage insert failed:", insertError);
    return false;
  }

  return true;
}
