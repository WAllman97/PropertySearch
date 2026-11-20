// Public sign-up for buyers.
//   GET  /api/buyer-signup?invite=<code> -> is this invite link valid, and whose
//   POST /api/buyer-signup { name, email, password, invite? }
//   POST /api/buyer-signup { action: "resend_confirmation", email, password, next? }
//        a new confirmation link, for buyers and agents (_lib/confirm-email.js)
//
// Without an invite this creates a new household with its own property list.
// With a partner's invite code (from Settings → Household) the new account
// joins that household and shares its list, calendar and notifications.
//
// Public sign-ups are switched off in Supabase, so accounts are created here
// with the service role, unconfirmed: we email a link to confirm the address
// before they can log in (_lib/confirm-email.js), the same as agents
// (api/agent-signup.js). New households get the app only: the scraper, its
// daily email and AI scoring stay with the original household.
import { supabaseAdmin } from "./_lib/household.js";
import { withCors } from "./_lib/cors.js";
import { handleResendConfirmation, sendConfirmEmail } from "./_lib/confirm-email.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_RE = /^[0-9a-f]{24}$/;
const MAX_MEMBERS = 4;
// Cheap brake on scripted sign-ups: new households across everyone, per hour.
const MAX_NEW_HOUSEHOLDS_PER_HOUR = 30;

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

async function findInvite(code) {
  const invite = clean(code, 40).toLowerCase();
  if (!INVITE_RE.test(invite)) return null;

  const { data: household } = await supabaseAdmin
    .from("households")
    .select("id, name")
    .eq("invite_code", invite)
    .maybeSingle();
  if (!household) return null;

  const { count } = await supabaseAdmin
    .from("household_members")
    .select("user_id", { count: "exact", head: true })
    .eq("household_id", household.id);

  return { ...household, full: (count || 0) >= MAX_MEMBERS };
}

export default withCors(handler);

async function handler(req, res) {
  try {
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "POST") return await handlePost(req, res);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
}

async function handleGet(req, res) {
  const invite = await findInvite(req.query.invite);
  if (!invite) return res.status(404).json({ error: "This invite link isn't valid any more." });
  if (invite.full) return res.status(409).json({ error: "This household is full." });
  return res.status(200).json({ householdName: invite.name });
}

async function handlePost(req, res) {
  const body = req.body || {};
  if (body.action === "resend_confirmation") return handleResendConfirmation(req, res);

  // Honeypot: real users never see or fill this field.
  if (body.website) {
    return res.status(200).json({ success: true });
  }

  const name = clean(body.name, 100);
  const email = clean(body.email, 254).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";

  if (!name) {
    return res.status(400).json({ error: "Please add your name" });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Please add a valid email address" });
  }
  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: "Password must be 8 to 72 characters" });
  }

  let invite = null;
  if (body.invite) {
    invite = await findInvite(body.invite);
    if (!invite) {
      return res.status(400).json({ error: "This invite link isn't valid any more. Ask for a new one." });
    }
    if (invite.full) {
      return res.status(409).json({ error: "This household already has the maximum number of people." });
    }
  } else {
    const since = new Date(Date.now() - 3600000).toISOString();
    const { count } = await supabaseAdmin
      .from("households")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since);
    if ((count || 0) >= MAX_NEW_HOUSEHOLDS_PER_HOUR) {
      return res.status(429).json({ error: "Lots of people are signing up right now. Please try again in an hour." });
    }
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: false,
    user_metadata: { role: "buyer", name },
  });

  if (error || !data?.user) {
    const exists = /already|registered|exists/i.test(error?.message || "");
    if (!exists) console.error("Buyer sign-up failed:", error);
    return res.status(exists ? 409 : 500).json({
      error: exists
        ? "There's already an account with that email. Log in instead."
        : "Could not create your account. Please try again.",
    });
  }

  const userId = data.user.id;
  let householdId = invite?.id;
  let createdHousehold = null;

  if (!householdId) {
    const firstName = name.split(/\s+/)[0];
    const { data: household, error: householdError } = await supabaseAdmin
      .from("households")
      .insert({ name: `${firstName}'s household` })
      .select("id")
      .single();
    if (householdError) {
      console.error("Household insert failed:", householdError);
      await supabaseAdmin.auth.admin.deleteUser(userId);
      return res.status(500).json({ error: "Could not create your account. Please try again." });
    }
    householdId = createdHousehold = household.id;
  }

  const { error: memberError } = await supabaseAdmin
    .from("household_members")
    .insert({ user_id: userId, household_id: householdId });

  if (memberError) {
    console.error("Household member insert failed:", memberError);
    // Don't leave a login (or an empty household) with no way in behind.
    await supabaseAdmin.auth.admin.deleteUser(userId);
    if (createdHousehold) await supabaseAdmin.from("households").delete().eq("id", createdHousehold);
    return res.status(500).json({ error: "Could not create your account. Please try again." });
  }

  // The account is ready; it opens once the email is confirmed. If sending
  // fails they can ask for a new link from the log-in screen.
  let emailed = true;
  try {
    const result = await sendConfirmEmail(req, { email, password, name });
    if (result?.sent === false) emailed = false;
  } catch (sendError) {
    console.error("Confirmation email failed:", sendError);
    emailed = false;
  }

  return res.status(200).json({ success: true, joined: Boolean(invite), confirmEmail: true, emailed });
}
