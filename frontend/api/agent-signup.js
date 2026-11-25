// Public sign-up for estate agents.
//   GET  /api/agent-signup?code=BROOKS-WANDSWORTH-7F3A2 -> { agency, branch, full }
//   POST /api/agent-signup { name, agency, branch, phone, email, password, code }
//   POST /api/agent-signup { action: "request_seat", code, name, email, branch, phone }
//        when the agency's seats are full: asks the admin for one more place
//   POST /api/agent-signup { action: "add_profile", code, name, phone }   signed in
//        an existing account (e.g. a buyer) becomes an agent too, with a code
//
// Public sign-ups are switched off in Supabase (the household app is
// invite-only), so agent accounts are created here with the service role.
// They start unconfirmed and must use the link we email before they can log
// in (_lib/confirm-email.js, the same as buyers). They are never added
// to household_members, so they can't see any household data: only their own
// agent profile, listings, slots and the bookings on them.
//
// Agents need a sign-up code so strangers can't fill buyers' cards with fake
// viewing times: one of the per-agency codes made on /admin (migration 019),
// or the older single AGENT_SIGNUP_CODE if that's set in Vercel.
//
// Free trials from a buyer's invite (migration 034) are actions on this
// route too, handled in _lib/agent-trials.js (see the list there):
// send_invite, request_invite, invite_lookup (or GET ?invite=),
// invite_signup, invite_opt_out, add_code, request_code, admin_code_email.
import { requireUser, supabaseAdmin } from "./_lib/household.js";
import { withCors } from "./_lib/cors.js";
import { sendConfirmEmail } from "./_lib/confirm-email.js";
import {
  CODE_ERROR,
  EMAIL_RE,
  clean,
  fullError,
  handleAddCode,
  handleAdminCodeEmail,
  handleInviteLookup,
  handleInviteOptOut,
  handleInviteSignup,
  handleRequestCode,
  handleRequestInvite,
  handleSendInvite,
  lookUpCode,
  normaliseCode,
} from "./_lib/agent-trials.js";

export default withCors(handler);

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

// Someone already signed in (e.g. a buyer) becoming an agent too. Same rule
// as a new sign-up: they need a live branch code, which takes a seat and
// decides the agency and branch. Agents can't add their own profile row
// directly (migration 026), so this is the only way in for them.
async function handleAddProfile(req, res, body) {
  const user = await requireUser(req, res);
  if (!user) return;

  const { data: existing } = await supabaseAdmin
    .from("agents")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existing) return res.status(200).json({ success: true });

  const code = normaliseCode(body.code);
  const legacyCode = process.env.AGENT_SIGNUP_CODE;
  const usesLegacyCode = Boolean(legacyCode) && clean(body.code, 100) === legacyCode;
  const profile = {
    name: clean(body.name, 100),
    agency: clean(body.agency, 100),
    branch: clean(body.branch, 100) || null,
    phone: clean(body.phone, 40) || null,
    email: (user.email || "").toLowerCase(),
  };

  let claimedCode = null;
  if (!usesLegacyCode) {
    const found = await lookUpCode(code);
    if (!found) return res.status(403).json({ error: CODE_ERROR });
    if (found.full) return res.status(409).json({ error: fullError(found), full: true });
    profile.agency = found.agency;
    if (found.branch) profile.branch = found.branch;
    const { data: agency, error: claimError } = await supabaseAdmin.rpc("claim_agent_code", { p_code: code });
    if (claimError || !agency) {
      if (claimError) console.error("claim_agent_code failed:", claimError);
      return res.status(409).json({ error: fullError(found), full: true });
    }
    claimedCode = code;
  }

  if (!profile.name || !profile.agency) {
    if (claimedCode) await supabaseAdmin.rpc("release_agent_code", { p_code: claimedCode });
    return res.status(400).json({ error: "Please add your name and agency" });
  }

  const { error } = await supabaseAdmin
    .from("agents")
    .insert({ user_id: user.id, ...profile, signup_code: claimedCode });
  if (error) {
    console.error("Agent profile insert failed:", error);
    if (claimedCode) await supabaseAdmin.rpc("release_agent_code", { p_code: claimedCode });
    return res.status(500).json({ error: "Could not set up your agent profile. Please try again." });
  }
  return res.status(200).json({ success: true });
}

async function handler(req, res) {
  if (req.method === "GET") {
    if (req.query?.invite) return handleInviteLookup(req, res, req.query.invite);
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
  if (body.action === "add_profile") return handleAddProfile(req, res, body);
  if (body.action === "send_invite") return handleSendInvite(req, res, body);
  if (body.action === "request_invite") return handleRequestInvite(req, res, body);
  if (body.action === "invite_lookup") return handleInviteLookup(req, res, body.token);
  if (body.action === "invite_signup") return handleInviteSignup(req, res, body);
  if (body.action === "invite_opt_out") return handleInviteOptOut(req, res, body);
  if (body.action === "add_code") return handleAddCode(req, res, body);
  if (body.action === "request_code") return handleRequestCode(req, res, body);
  if (body.action === "admin_code_email") return handleAdminCodeEmail(req, res, body);

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
    email_confirm: false,
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

  // Unconfirmed until they use the link we email (_lib/confirm-email.js).
  let emailed = true;
  try {
    const result = await sendConfirmEmail(req, { email: profile.email, password, name: profile.name, next: "/agent" });
    if (result?.sent === false) emailed = false;
  } catch (sendError) {
    console.error("Agent confirmation email failed:", sendError);
    emailed = false;
  }

  return res.status(200).json({ success: true, confirmEmail: true, emailed });
}
