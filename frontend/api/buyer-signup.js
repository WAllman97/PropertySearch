// Public sign-up for buyers.
//   GET  /api/buyer-signup?invite=<code> -> is this invite link valid, and whose
//   POST /api/buyer-signup { name, email, password, invite? }
//   POST /api/buyer-signup { action: "join", invite, bringHomes }   signed in
//        someone who already has an account joins their partner's household
//   POST /api/buyer-signup?unsubscribe=<token>&kind=matches|price_drops
//        one-click unsubscribe from the match / price-cut emails
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
import { requireUser, supabaseAdmin } from "./_lib/household.js";
import { listingKey } from "./_lib/listing.js";
import { setPreferenceByToken } from "./_lib/email-prefs.js";
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
  // One-click unsubscribe from a mail app (List-Unsubscribe-Post), or the
  // button on /unsubscribe. Token in the address; no login (migration 028).
  if (req.query?.unsubscribe) {
    const on = req.body?.resubscribe === true;
    const ok = await setPreferenceByToken(req.query.unsubscribe, String(req.query.kind || ""), on);
    return ok ? res.status(200).json({ success: true, subscribed: on }) : res.status(404).json({ error: "This link isn't valid any more" });
  }
  const body = req.body || {};
  if (body.action === "resend_confirmation") return handleResendConfirmation(req, res);
  if (body.action === "join") return handleJoin(req, res, body);

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

// An existing account joins a partner's household from their invite link,
// instead of having to sign up again with another email. If they were on
// their own, their saved homes come too (unless the partner already has
// that home), with their notes, offers and viewing requests, and the old
// empty household is removed. Searches belong to the person, so they follow.
async function handleJoin(req, res, body) {
  const user = await requireUser(req, res);
  if (!user) return;

  const invite = await findInvite(body.invite);
  if (!invite) return res.status(400).json({ error: "This invite link isn't valid any more. Ask for a new one." });

  const { data: member } = await supabaseAdmin
    .from("household_members")
    .select("household_id, households(is_original)")
    .eq("user_id", user.id)
    .maybeSingle();
  if (member?.household_id === invite.id) return res.status(200).json({ success: true, moved: 0 });
  if (invite.full) return res.status(409).json({ error: "This household already has the maximum number of people." });
  if (member?.households?.is_original) {
    return res.status(409).json({ error: "This account runs the original household, so it can't move." });
  }

  const oldId = member?.household_id || null;
  let moved = 0;
  let alone = false;
  if (oldId) {
    const { count } = await supabaseAdmin
      .from("household_members")
      .select("user_id", { count: "exact", head: true })
      .eq("household_id", oldId);
    alone = (count || 0) <= 1;
  }

  if (oldId && alone && body.bringHomes !== false) {
    const [{ data: mine }, { data: theirs }] = await Promise.all([
      supabaseAdmin.from("properties").select("id, listing_url").eq("household_id", oldId),
      supabaseAdmin.from("properties").select("listing_url").eq("household_id", invite.id),
    ]);
    const have = new Set((theirs || []).map((p) => listingKey(p.listing_url) || p.listing_url));
    const ids = (mine || [])
      .filter((p) => !have.has(listingKey(p.listing_url) || p.listing_url))
      .map((p) => p.id);
    if (ids.length) {
      // Notes hang off the property, so they move with it.
      await supabaseAdmin.from("properties").update({ household_id: invite.id }).in("id", ids);
      await supabaseAdmin.from("offers").update({ household_id: invite.id }).in("property_id", ids);
      await supabaseAdmin.from("viewing_requests").update({ household_id: invite.id }).in("property_id", ids);
      moved = ids.length;
    }
    // Commute profile and buying position: keep the partner's if they have one.
    const hasOwn = async (table) => {
      const { count } = await supabaseAdmin
        .from(table)
        .select("household_id", { count: "exact", head: true })
        .eq("household_id", invite.id);
      return Boolean(count);
    };
    if (!(await hasOwn("buyer_profiles"))) {
      await supabaseAdmin.from("buyer_profiles").update({ household_id: invite.id }).eq("household_id", oldId);
    }
    if (!(await hasOwn("buyer_positions"))) {
      // A proof document lives in a folder named after the household
      // (migration 017), so it moves folder too.
      const { data: position } = await supabaseAdmin
        .from("buyer_positions")
        .select("proof_path")
        .eq("household_id", oldId)
        .maybeSingle();
      let proofPath = null;
      if (position?.proof_path) {
        const target = `${invite.id}/${position.proof_path.split("/")[1]}`;
        const { error: moveError } = await supabaseAdmin.storage
          .from("position-proofs")
          .move(position.proof_path, target);
        if (!moveError) proofPath = target;
        else console.error("Proof document move failed:", moveError);
      }
      await supabaseAdmin
        .from("buyer_positions")
        .update({ household_id: invite.id, proof_path: proofPath, ...(proofPath ? {} : { proof_name: null, proof_uploaded_at: null }) })
        .eq("household_id", oldId);
    }
  }

  const { error } = oldId
    ? await supabaseAdmin.from("household_members").update({ household_id: invite.id }).eq("user_id", user.id)
    : await supabaseAdmin.from("household_members").insert({ user_id: user.id, household_id: invite.id });
  if (error) {
    console.error("Household join failed:", error);
    return res.status(500).json({ error: "Could not join the household. Please try again." });
  }

  // Nobody left in the old household: remove it (and anything not moved).
  if (oldId && alone) {
    const { error: deleteError } = await supabaseAdmin.from("households").delete().eq("id", oldId);
    if (deleteError) console.error("Old household delete failed:", deleteError);
  }

  return res.status(200).json({ success: true, moved, householdName: invite.name });
}
