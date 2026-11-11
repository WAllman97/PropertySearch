import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Read before createClient(): the client consumes and clears the URL hash
// from a password-reset link, and its PASSWORD_RECOVERY event can fire before
// React has subscribed.
export const arrivedFromPasswordReset =
  typeof window !== "undefined" && /type=recovery/.test(window.location.hash);

export const supabase = createClient(
  supabaseUrl,
  supabaseAnonKey
);