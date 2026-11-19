// Public sign-up for estate agents.
//   GET  /api/agent-signup?code=BROOKS-WANDSWORTH-7F3A2 -> { agency, branch, full }
//   POST /api/agent-signup { name, agency, branch, phone, email, password, code }
//   POST /api/agent-signup { action: "request_seat", code, name, email, branch, phone }
//        when the agency's seats are full: asks the admin for one more place
//
// Public sign-ups are switched off in Supabase (the household app is
// invite-only), so agent accounts are created here with the service role.
// They are confirmed straight away (no email round trip) and are never added
// to household_members, so they can't see any household data: only their own
// agent profile, listings, slots and the bookings on them.
//
// Agents need a sign-up code so strangers can't fill buyers' cards with fake
// viewing times: one of the per-agency codes made on /admin (migration 019),
// or the older single AGENT_SIGNUP_CODE if that's set in Vercel.
import { supabaseAdmin } from "./_lib/household.js";
import { withCors } from "./_lib/cors.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^[A-Z0-9-]{4,40}$/;

const normaliseCode = (value) => (typeof value === "string" ? value.trim().toUpperCase() : "");

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

export default withCors(handler);

// A live branch code: { agency, branch, full }, or null if it's wrong or
// off. full: every seat the branch asked for is taken.
async function lookUpCode(code) {
  if (!CODE_RE.test(code)) return null;
  const { data } = await supabaseAdmin
    .from("agent_invite_codes")
    .select("agency, branch, is_active, max_uses, uses")
    .eq("code", code)
    .maybeSingle();
  if (!data || !data.is_active) return null;
  return {
    agency: data.agency,
    branch: data.branch,
    full: data.max_uses !== null && data.uses >= data.max_uses,
  };
}

const CODE_ERROR =
  "That sign-up code isn't right. Ask PropertySearch for your agency's code.";
const branchName = (found) => [found.agency, found.branch].filter(Boolean).join(" · ");
const fullError = (found) =>
  `${branchName(found)} has used all its places on PropertySearch. Request a place and we'll add one.`;

async function handleSeatRequest(req, res, body) {
  const code = normaliseCode(body.code);
  const found = await lookUpCode(code);
  if (!found) return res.status(403).json({ error: CODE_ERROR });
  if (!found.full) {
    return res.status(200).json({ success: true, available: true });
  }

  const request = {
    code,
    name: clean(body.name, 100),
    email: clean(body.email, 254).toLowerCase(),
    branch: clean(body.branch, 100) || null,
    phone: clean(body.phone, 40) || null,
  };
  if (!request.name || !EMAIL_RE.test(request.email)) {
    return res.status(400).json({ error: "Please add your name and work email" });
  }

  const { error } = await supabaseAdmin.from("agent_seat_requests").insert(request);
  // Asked already: same answer, nothing new stored.
  if (error && error.code !== "23505") {
    console.error("Seat request failed:", error);
    return res.status(500).json({ error: "Could not send your request. Please try again." });
  }
  return res.status(200).json({ success: true, requested: true });
}

async function handler(req, res) {
  if (req.method === "GET") {
    const found = await lookUpCode(normaliseCode(req.query?.code));
    return found
      ? res.status(200).json(found)
      : res.status(404).json({ error: CODE_ERROR });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};

  // Honeypot: real users never see or fill this field.
  if (body.website) {
    return res.status(200).json({ success: true });
  }

  if (body.action === "request_seat") return handleSeatRequest(req, res, body);

  const code = normaliseCode(body.code);
  const legacyCode = process.env.AGENT_SIGNUP_CODE;
  const usesLegacyCode = Boolean(legacyCode) && clean(body.code, 100) === legacyCode;
  if (!usesLegacyCode) {
    const found = await lookUpCode(code);
    if (!found) return res.status(403).json({ error: CODE_ERROR });
    if (found.full) return res.status(409).json({ error: fullError(found), full: true });
    // The code decides the agency and branch, so everyone at a branch is
    // grouped together (pricing is per branch).
    body.agency = found.agency;
    if (found.branch) body.branch = found.branch;
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

  // Take a place on the code now (atomically: two agents can't both get the
  // last one); give it back below if the account can't be created.
  let claimedCode = null;
  if (!usesLegacyCode) {
    const { data: agency, error: claimError } = await supabaseAdmin.rpc("claim_agent_code", {
      p_code: code,
    });
    if (claimError || !agency) {
      if (claimError) console.error("claim_agent_code failed:", claimError);
      // Someone took the last seat a moment ago.
      const found = await lookUpCode(code);
      return found?.full
        ? res.status(409).json({ error: fullError(found), full: true })
        : res.status(403).json({ error: CODE_ERROR });
    }
    claimedCode = code;
  }
  const releaseCode = () =>
    claimedCode ? supabaseAdmin.rpc("release_agent_code", { p_code: claimedCode }) : null;

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: profile.email,
    password,
    email_confirm: true,
    user_metadata: { role: "agent", name: profile.name },
  });

  if (error || !data?.user) {
    await releaseCode();
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
    .insert({ user_id: data.user.id, ...profile, signup_code: claimedCode });

  if (profileError) {
    console.error("Agent profile insert failed:", profileError);
    // Don't leave a login with no agent profile behind.
    await supabaseAdmin.auth.admin.deleteUser(data.user.id);
    await releaseCode();
    return res.status(500).json({ error: "Could not create your account. Please try again." });
  }

  return res.status(200).json({ success: true });
}
