// Public sign-up for estate agents.
//   POST /api/agent-signup { name, agency, branch, phone, email, password, code }
//
// Public sign-ups are switched off in Supabase (the household app is
// invite-only), so agent accounts are created here with the service role.
// They are confirmed straight away (no email round trip) and are never added
// to household_members, so they can't see any household data: only their own
// agent profile, listings, slots and the bookings on them.
//
// If AGENT_SIGNUP_CODE is set, agents must enter it (hand it out with the
// link) so strangers can't fill buyers' cards with fake viewing times.
import { supabaseAdmin } from "./_lib/household.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};

  // Honeypot: real users never see or fill this field.
  if (body.website) {
    return res.status(200).json({ success: true });
  }

  const requiredCode = process.env.AGENT_SIGNUP_CODE;
  if (requiredCode && clean(body.code, 100) !== requiredCode) {
    return res.status(403).json({ error: "That agency code isn't right" });
  }

  const profile = {
    name: clean(body.name, 100),
    agency: clean(body.agency, 100),
    branch: clean(body.branch, 100) || null,
    phone: clean(body.phone, 40) || null,
    email: clean(body.email, 254).toLowerCase(),
  };
  const password = typeof body.password === "string" ? body.password : "";

  if (!profile.name || !profile.agency) {
    return res.status(400).json({ error: "Please add your name and agency" });
  }

  if (!EMAIL_RE.test(profile.email)) {
    return res.status(400).json({ error: "Please add a valid email address" });
  }

  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: "Password must be 8 to 72 characters" });
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: profile.email,
    password,
    email_confirm: true,
    user_metadata: { role: "agent", name: profile.name },
  });

  if (error || !data?.user) {
    const exists = /already|registered|exists/i.test(error?.message || "");
    if (!exists) console.error("Agent sign-up failed:", error);
    return res.status(exists ? 409 : 500).json({
      error: exists
        ? "There's already an account with that email. Log in instead."
        : "Could not create your account. Please try again.",
    });
  }

  const { error: profileError } = await supabaseAdmin
    .from("agents")
    .insert({ user_id: data.user.id, ...profile });

  if (profileError) {
    console.error("Agent profile insert failed:", profileError);
    // Don't leave a login with no agent profile behind.
    await supabaseAdmin.auth.admin.deleteUser(data.user.id);
    return res.status(500).json({ error: "Could not create your account. Please try again." });
  }

  return res.status(200).json({ success: true });
}
