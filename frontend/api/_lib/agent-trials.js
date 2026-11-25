// Free trials for agents a buyer invites (migration 034), handled by
// /api/agent-signup. Vercel allows 12 routes and we're at 12, so these are
// actions on the existing sign-up route rather than a route of their own.
//
//   buyer (signed in, household):
//     { action: "send_invite", propertyId, agentEmail?, agentName?, viewingRequestId? }
//        emails the agent a single-use sign-up link; with no email, hands the
//        buyer the link to send themselves
//   agent answering a viewing request (no account, the request's token):
//     { action: "request_invite", requestToken }   -> { available, invite }
//   anyone with an invite link:
//     GET ?invite=<token>  or  { action: "invite_lookup", token }  -> prefill
//     { action: "invite_signup", token, name, agency, branch?, phone?, password, email? }
//     { action: "invite_opt_out", token }   never email this address again
//   signed-in agent on a trial:
//     { action: "add_code", code }          move onto a branch code
//     { action: "request_code", agency?, branch?, phone? }   ask us for one
//   admin:
//     { action: "admin_code_email", agentId }   email a trial agent their new code
//
// Why a trial at all: most homes buyers save are marketed by agents who
// aren't on PropertySearch. The buyer is our best salesperson, so an invited
// agent can join without a branch code and take bookings for 14 days. After
// that, new bookings stop (slot_blocked, migration 034) until they have a
// code, which keeps billing per branch.
import { randomUUID } from "node:crypto";
import { requireHouseholdUser, requireUser, supabaseAdmin } from "./household.js";
import { appBaseUrl } from "./booking.js";
import { emailLayout, escapeHtml, sendEmail } from "./email.js";
import { sendConfirmEmail } from "./confirm-email.js";

// --- Shared with the code sign-up in agent-signup.js ---------------------------------

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CODE_RE = /^[A-Z0-9-]{4,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const normaliseCode = (value) => (typeof value === "string" ? value.trim().toUpperCase() : "");

export function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

// A live branch code: { agency, branch, full }, or null if it's wrong or
// off. full: every seat the branch asked for is taken.
export async function lookUpCode(code) {
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

export const CODE_ERROR =
  "That sign-up code isn't right. Ask PropertySearch for your agency's code.";
export const branchName = (found) => [found.agency, found.branch].filter(Boolean).join(" · ");
export const fullError = (found) =>
  `${branchName(found)} has used all its places on PropertySearch. Request a place and we'll add one.`;

// --- Invites ------------------------------------------------------------------------

const TRIAL_DAYS = 14;
const INVITE_DAYS = 30;
const DAY = 24 * 3600 * 1000;
const MAX_INVITES_PER_HOUSEHOLD_PER_DAY = 10;
// Across every buyer: an agent several buyers invite still gets at most a
// few invite emails a week.
const MAX_EMAILS_PER_ADDRESS_PER_WEEK = 3;
// Lifetime per household, and across the whole app per day: invites are a
// favour to a real buyer, never a mailing list.
const MAX_INVITES_PER_HOUSEHOLD_EVER = 40;
const MAX_INVITE_EMAILS_PER_DAY = 200;
const CONTACT_EMAIL = "hello@viewpal.co.uk";

const isLive = (invite) => invite && !invite.used_at && new Date(invite.expires_at).getTime() > Date.now();
const firstWord = (value) => String(value || "").trim().split(/\s+/)[0] || "";
const inviteUrl = (req, token) => `${appBaseUrl(req)}/agent?invite=${token}`;

const button = (href, label) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;background:#223a33;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:10px;">${escapeHtml(label)}</a>`;

async function isAgentEmail(email) {
  if (!email) return false;
  const { data } = await supabaseAdmin.from("agents").select("user_id").eq("email", email).limit(1);
  return Boolean(data?.length);
}

// Asked not to get invites, or not to get viewing requests (migration 023):
// either way they don't want email from us.
async function optedOut(email) {
  if (!email) return false;
  const [{ data: a }, { data: b }] = await Promise.all([
    supabaseAdmin.from("agent_invite_optouts").select("email").eq("email", email).maybeSingle(),
    supabaseAdmin.from("viewing_request_opt_outs").select("email").eq("email", email).maybeSingle(),
  ]);
  return Boolean(a || b);
}

// An expired, unused invite gets a fresh link and 30 more days, rather than
// a second row (one open invite per household and address).
async function renew(invite, changes = {}) {
  const { data, error } = await supabaseAdmin
    .from("agent_invites")
    .update({
      ...changes,
      token: randomUUID(),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + INVITE_DAYS * DAY).toISOString(),
      emailed_at: null,
    })
    .eq("id", invite.id)
    .is("used_at", null)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadInvite(token) {
  if (!UUID_RE.test(String(token || ""))) return null;
  const { data } = await supabaseAdmin.from("agent_invites").select("*").eq("token", token).maybeSingle();
  return data;
}

// The login an invite was used for, when it was made from this invite and its
// email was never confirmed: the agent can start again with new details.
// A confirmed account is never returned (and so never replaced).
async function unconfirmedClaim(invite) {
  if (!invite?.used_at || !invite.used_by) return null;
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(invite.used_by);
  const user = data?.user;
  if (error || !user || user.email_confirmed_at || user.confirmed_at) return null;
  if (user.user_metadata?.role !== "agent") return null;
  return user;
}

async function buyerFirstName(invite) {
  if (invite.viewing_request_id) {
    const { data } = await supabaseAdmin
      .from("viewing_requests")
      .select("buyer_name")
      .eq("id", invite.viewing_request_id)
      .maybeSingle();
    if (data?.buyer_name) return firstWord(data.buyer_name);
  }
  if (invite.invited_by_user) {
    const { data } = await supabaseAdmin.auth.admin.getUserById(invite.invited_by_user);
    const meta = data?.user?.user_metadata || {};
    return firstWord(meta.name || meta.full_name);
  }
  return "";
}

// Text a buyer controls (their name, the home's address) goes into an email
// from our domain: keep it short and strip anything link-like, so the
// invite can't be used to carry someone else's message or a phishing link.
function plainText(value, max) {
  return String(value || "")
    .replace(/(https?:\/\/|www\.)\S*/gi, "")
    .replace(/\b[\w-]+(\.[\w-]+)*\.[a-z]{2,}(\/\S*)?/gi, "")
    .replace(/[<>]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

function inviteEmailHtml(req, invite, { buyer: rawBuyer, address: rawAddress }) {
  const buyer = plainText(rawBuyer, 30);
  const address = plainText(rawAddress, 120);
  const url = inviteUrl(req, invite.token);
  const stopUrl = `${url}&stop=1`;
  const hi = firstWord(invite.agent_name);
  const who = buyer ? escapeHtml(buyer) : "A buyer";
  return emailLayout(
    `${buyer || "A buyer"} would like to book viewings with you`,
    `<p style="font-size:15px;line-height:1.5;margin:0 0 12px;">${hi ? `Hi ${escapeHtml(hi)},` : "Hello,"}</p>
    <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">${who} is buying a home with PropertySearch${
      address ? ` and has saved <strong>${escapeHtml(address)}</strong>, which you're marketing` : ""
    }. They asked us to invite you.</p>
    <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">On PropertySearch, buyers book viewings straight into your diary.
    You set your viewing hours once. You see each buyer's position before they arrive. No phone tag.</p>
    <p style="font-size:15px;line-height:1.5;margin:0 0 20px;"><strong>Try it free for 14 days.</strong> No branch code needed.</p>
    <p style="margin:0 0 20px;">${button(url, "Start free trial")}</p>
    <p style="font-size:13px;line-height:1.5;color:#6b7280;margin:0 0 12px;">This link is just for you and works for 30 days.
    Questions? Email <a href="mailto:${CONTACT_EMAIL}" style="color:#223a33;">${CONTACT_EMAIL}</a>.</p>
    <hr style="border:0;border-top:1px solid #e4ddd2;margin:16px 0;">
    <p style="font-size:12px;line-height:1.5;color:#9a9186;margin:0;">You're getting this because a buyer asked us to invite you.
    <a href="${escapeHtml(stopUrl)}" style="color:#9a9186;">Not interested — don't email me again</a>.</p>`
  );
}

export async function handleSendInvite(req, res, body) {
  const user = await requireHouseholdUser(req, res);
  if (!user) return;

  const email = clean(body.agentEmail, 254).toLowerCase();
  const agentName = clean(body.agentName, 100);
  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "That email doesn't look right. Leave it blank to send the invite yourself." });
  }
  if (email.endsWith("@viewpal.co.uk")) {
    return res.status(400).json({ error: "That's one of our addresses, not the agent's" });
  }

  const { data: property } = await supabaseAdmin
    .from("properties")
    .select("id, address")
    .eq("id", String(body.propertyId || ""))
    .eq("household_id", user.householdId)
    .maybeSingle();
  if (!property) return res.status(404).json({ error: "Home not found" });

  // Only link a viewing request of this household's.
  let viewingRequestId = null;
  if (UUID_RE.test(String(body.viewingRequestId || ""))) {
    const { data: request } = await supabaseAdmin
      .from("viewing_requests")
      .select("id")
      .eq("id", body.viewingRequestId)
      .eq("household_id", user.householdId)
      .maybeSingle();
    viewingRequestId = request?.id || null;
  }

  if (email && (await isAgentEmail(email))) {
    return res.status(409).json({ error: "This agent is already on PropertySearch.", onApp: true });
  }
  if (await optedOut(email)) {
    return res.status(409).json({ error: "This agent has asked not to get emails from PropertySearch. Please contact them directly." });
  }

  const now = Date.now();
  const { count: today } = await supabaseAdmin
    .from("agent_invites")
    .select("id", { count: "exact", head: true })
    .eq("household_id", user.householdId)
    .gte("created_at", new Date(now - DAY).toISOString());
  if ((today || 0) >= MAX_INVITES_PER_HOUSEHOLD_PER_DAY) {
    return res.status(429).json({ error: "That's a lot of invites today. Please try again tomorrow." });
  }
  // Ceilings against abuse: one household can't invite more agents than a
  // real search needs, and the whole app can't be turned into a mailer.
  const [{ count: ever }, { count: everyoneToday }] = await Promise.all([
    supabaseAdmin.from("agent_invites").select("id", { count: "exact", head: true }).eq("household_id", user.householdId),
    supabaseAdmin
      .from("agent_invites")
      .select("id", { count: "exact", head: true })
      .gte("emailed_at", new Date(now - DAY).toISOString()),
  ]);
  if ((ever || 0) >= MAX_INVITES_PER_HOUSEHOLD_EVER) {
    return res.status(429).json({ error: `You've invited plenty of agents already. Email ${CONTACT_EMAIL} if you need more.` });
  }
  if (email && (everyoneToday || 0) >= MAX_INVITE_EMAILS_PER_DAY) {
    return res.status(429).json({ error: "We've sent a lot of invites today. Please try again tomorrow, or share the link yourself." });
  }

  let invite = null;
  if (email) {
    const { data: existing } = await supabaseAdmin
      .from("agent_invites")
      .select("*")
      .eq("household_id", user.householdId)
      .eq("email", email)
      .is("used_at", null)
      .maybeSingle();
    // A live invite whose email never went out (Resend down, say) is sent
    // again, rather than answering "already invited" for 30 days.
    if (isLive(existing) && existing.emailed_at) {
      return res.status(200).json({ success: true, already: true });
    }

    const { count: thisWeek } = await supabaseAdmin
      .from("agent_invites")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .gte("emailed_at", new Date(now - 7 * DAY).toISOString());
    if ((thisWeek || 0) >= MAX_EMAILS_PER_ADDRESS_PER_WEEK) {
      return res.status(429).json({ error: "This agent has had a few invites this week already. Please try again next week." });
    }

    if (isLive(existing)) {
      invite = existing;
    } else if (existing) {
      try {
        invite = await renew(existing, { agent_name: agentName || existing.agent_name, property_id: property.id, invited_by_user: user.id });
      } catch (error) {
        console.error("agent invite renew failed:", error);
        return res.status(500).json({ error: "Could not create the invite. Please try again." });
      }
    }
  }

  if (!invite) {
    const { data, error } = await supabaseAdmin
      .from("agent_invites")
      .insert({
        email: email || null,
        agent_name: agentName || null,
        invited_by_user: user.id,
        household_id: user.householdId,
        property_id: property.id,
        viewing_request_id: viewingRequestId,
      })
      .select("*")
      .single();
    if (error) {
      // Another tap a moment ago made it.
      if (error.code === "23505") return res.status(200).json({ success: true, already: true });
      console.error("agent invite insert failed:", error);
      return res.status(500).json({ error: "Could not create the invite. Please try again." });
    }
    invite = data;
  }

  const meta = user.user_metadata || {};
  const buyer = firstWord(meta.name || meta.full_name);

  // The link for the buyer to send themselves (WhatsApp, text, the portal's
  // contact form), like a viewing request: when there's no email for the
  // agent, or ours didn't go.
  const url = inviteUrl(req, invite.token);
  const shareText = [
    `Hi${agentName ? ` ${firstWord(agentName)}` : ""}, I use PropertySearch to book viewings${property.address ? ` and I've saved ${property.address}` : ""}.`,
    "If you join, I can book your viewing times straight into your diary. It's free for 14 days, no code needed:",
    url,
    buyer ? `Thanks, ${buyer}` : "Thanks",
  ].join("\n\n");
  if (!email) {
    return res.status(200).json({ success: true, emailed: false, shareUrl: url, shareText });
  }

  let sent = null;
  try {
    sent = await sendEmail({
      to: email,
      subject: `${plainText(buyer, 30) || "A buyer"} invited you to PropertySearch`,
      html: inviteEmailHtml(req, invite, { buyer, address: property.address }),
    });
  } catch (sendError) {
    console.error("agent invite email failed:", sendError);
  }
  if (sent?.sent) {
    await supabaseAdmin.from("agent_invites").update({ emailed_at: new Date().toISOString() }).eq("id", invite.id);
    return res.status(200).json({ success: true, emailed: true });
  }
  // Not sent: emailed_at stays empty so a retry sends it again, and the
  // buyer can share the link themselves meanwhile.
  return res.status(200).json({ success: true, emailed: false, shareUrl: url, shareText });
}

// The agent answered a buyer's request on /request/<token> without an
// account: make (or reuse) an invite from that request, so the page can
// offer a one-tap trial. No email: they're already on the page.
export async function handleRequestInvite(req, res, body) {
  if (!UUID_RE.test(String(body.requestToken || ""))) {
    return res.status(404).json({ error: "This request link isn't valid" });
  }
  const { data: request } = await supabaseAdmin
    .from("viewing_requests")
    .select("id, household_id, property_id, requested_by, agent_email, agent_name, status")
    .eq("token", body.requestToken)
    .maybeSingle();
  if (!request) return res.status(404).json({ error: "This request link isn't valid" });

  // Only once they've confirmed or suggested a time.
  if (!["confirmed", "proposed"].includes(request.status)) {
    return res.status(200).json({ available: false });
  }
  const email = (request.agent_email || "").toLowerCase() || null;
  if (email && ((await isAgentEmail(email)) || (await optedOut(email)))) {
    return res.status(200).json({ available: false });
  }

  try {
    let { data: invite } = await supabaseAdmin
      .from("agent_invites")
      .select("*")
      .eq("viewing_request_id", request.id)
      .is("used_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // An earlier invite the buyer sent to a different address would lock the
    // sign-up to someone else's email: only reuse one for this agent.
    if (invite && email && invite.email && invite.email !== email) invite = null;
    if (!invite && email) {
      ({ data: invite } = await supabaseAdmin
        .from("agent_invites")
        .select("*")
        .eq("household_id", request.household_id)
        .eq("email", email)
        .is("used_at", null)
        .maybeSingle());
    }
    if (invite && !isLive(invite)) invite = await renew(invite);
    if (!invite) {
      const { data, error } = await supabaseAdmin
        .from("agent_invites")
        .insert({
          email,
          agent_name: request.agent_name || null,
          invited_by_user: request.requested_by,
          household_id: request.household_id,
          property_id: request.property_id,
          viewing_request_id: request.id,
        })
        .select("*")
        .single();
      if (error) throw error;
      invite = data;
    }
    return res.status(200).json({ available: true, invite: invite.token });
  } catch (error) {
    console.error("request invite failed:", error);
    return res.status(200).json({ available: false });
  }
}

export async function handleInviteLookup(req, res, token) {
  const invite = await loadInvite(token);
  if (!invite) return res.status(404).json({ error: "This invite link isn't valid." });
  const { data: optOut } = invite.email
    ? await supabaseAdmin.from("agent_invite_optouts").select("email").eq("email", invite.email).maybeSingle()
    : { data: null };
  // Used by a login that was never confirmed: still show the form, so
  // "Start again" (or reopening the link) can replace it.
  const reusable = invite.used_at && (await unconfirmedClaim(invite));
  if (invite.used_at && !reusable) {
    return res.status(410).json({ error: "This invite has been used. Log in instead.", used: true, optedOut: Boolean(optOut) });
  }
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return res.status(410).json({
      error: `This invite has expired. Ask the buyer for a new one, or email ${CONTACT_EMAIL}.`,
      optedOut: Boolean(optOut),
    });
  }
  let address = "";
  if (invite.property_id) {
    const { data } = await supabaseAdmin.from("properties").select("address").eq("id", invite.property_id).maybeSingle();
    address = data?.address || "";
  }
  return res.status(200).json({
    email: invite.email || "",
    emailLocked: Boolean(invite.email),
    name: invite.agent_name || "",
    buyer: await buyerFirstName(invite),
    address,
    trialDays: TRIAL_DAYS,
    optedOut: Boolean(optOut),
  });
}

export async function handleInviteOptOut(req, res, body) {
  const invite = await loadInvite(body.token);
  if (!invite) return res.status(404).json({ error: "This invite link isn't valid." });
  if (!invite.email) return res.status(200).json({ success: true });
  const { error } = await supabaseAdmin
    .from("agent_invite_optouts")
    .upsert({ email: invite.email }, { onConflict: "email", ignoreDuplicates: true });
  // "Don't email me again" means every email from us, so buyers' viewing
  // requests to this address stop too (they have their own opt-out list).
  await supabaseAdmin
    .from("viewing_request_opt_outs")
    .upsert({ email: invite.email }, { onConflict: "email", ignoreDuplicates: true })
    .then(({ error: requestOptOutError }) => {
      if (requestOptOutError) console.error("viewing request opt-out failed:", requestOptOutError);
    });
  if (error) {
    console.error("invite opt-out failed:", error);
    return res.status(500).json({ error: "Could not save that. Please try again." });
  }
  // The link stops working too.
  await supabaseAdmin
    .from("agent_invites")
    .update({ expires_at: new Date().toISOString() })
    .eq("email", invite.email)
    .is("used_at", null);
  return res.status(200).json({ success: true });
}

// Sign up from an invite: like the code sign-up, but with no code. The
// email is the invite's (when the buyer gave one), and the account starts a
// 14-day trial as a branch of its own.
export async function handleInviteSignup(req, res, body) {
  const invite = await loadInvite(body.token);
  if (!invite) return res.status(404).json({ error: "This invite link isn't valid." });
  // Signed up from this invite but never confirmed (a typo in the email, say,
  // then "Start again"): that login is replaced below, not a dead end.
  const stale = await unconfirmedClaim(invite);
  if (!stale && !isLive(invite)) {
    return res.status(410).json({
      error: invite.used_at
        ? "This invite has been used. Log in instead."
        : `This invite has expired. Ask the buyer for a new one, or email ${CONTACT_EMAIL}.`,
    });
  }
  if (stale && new Date(invite.expires_at).getTime() <= Date.now()) {
    return res.status(410).json({ error: `This invite has expired. Ask the buyer for a new one, or email ${CONTACT_EMAIL}.` });
  }

  const profile = {
    name: clean(body.name, 100),
    agency: clean(body.agency, 100),
    branch: clean(body.branch, 100) || null,
    phone: clean(body.phone, 40) || null,
    email: invite.email || clean(body.email, 254).toLowerCase(),
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

  if (stale) {
    // Deleting the login removes its agents row too (on delete cascade).
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(stale.id);
    if (deleteError) {
      console.error("Unconfirmed invite login delete failed:", deleteError);
      return res.status(500).json({ error: "Could not create your account. Please try again." });
    }
    await supabaseAdmin.from("branch_billing").delete().eq("branch_key", `agent:${stale.id}`);
    // used_by is already null (on delete set null): free the invite again.
    await supabaseAdmin.from("agent_invites").update({ used_at: null, used_by: null }).eq("id", invite.id).is("used_by", null);
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: profile.email,
    password,
    email_confirm: false,
    user_metadata: { role: "agent", name: profile.name },
  });
  if (error || !data?.user) {
    const exists = /already|registered|exists/i.test(error?.message || "");
    if (!exists) console.error("Invite sign-up failed:", error);
    return res.status(exists ? 409 : 500).json({
      error: exists
        ? `There's already an account with that email. Log in instead, or email ${CONTACT_EMAIL} and we'll set up your trial.`
        : "Could not create your account. Please try again.",
    });
  }
  const userId = data.user.id;

  // Use the invite up now (one statement, so it can't be used twice).
  const { data: claimed } = await supabaseAdmin
    .from("agent_invites")
    .update({ used_at: new Date().toISOString(), used_by: userId })
    .eq("id", invite.id)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("id");
  if (!claimed?.length) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    return res.status(410).json({ error: "This invite has just been used. Log in instead." });
  }

  const { error: profileError } = await supabaseAdmin.from("agents").insert({
    user_id: userId,
    ...profile,
    signup_code: null,
    trial_ends_at: new Date(Date.now() + TRIAL_DAYS * DAY).toISOString(),
    referred_by_household: invite.household_id,
  });
  if (profileError) {
    console.error("Trial agent insert failed:", profileError);
    // Don't leave a login with no agent profile, or a used-up invite, behind.
    await supabaseAdmin.auth.admin.deleteUser(userId);
    await supabaseAdmin.from("agent_invites").update({ used_at: null, used_by: null }).eq("id", invite.id);
    return res.status(500).json({ error: "Could not create your account. Please try again." });
  }

  // Shows as a trial branch on /admin, not a pilot. Best effort.
  const { error: billingError } = await supabaseAdmin
    .from("branch_billing")
    .upsert({ branch_key: `agent:${userId}`, plan: "trial" }, { onConflict: "branch_key", ignoreDuplicates: true });
  if (billingError) console.error("Trial billing row failed:", billingError);

  let emailed = true;
  try {
    const result = await sendConfirmEmail(req, { email: profile.email, password, name: profile.name, next: "/agent" });
    if (result?.sent === false) emailed = false;
  } catch (sendError) {
    console.error("Trial confirmation email failed:", sendError);
    emailed = false;
  }
  return res.status(200).json({ success: true, confirmEmail: true, emailed, email: profile.email });
}

// --- Converting a trial ------------------------------------------------------------

async function ownAgent(user) {
  const { data } = await supabaseAdmin
    .from("agents")
    .select("user_id, name, agency, branch, phone, email, signup_code, trial_ends_at, code_requested_at")
    .eq("user_id", user.id)
    .maybeSingle();
  return data;
}

// Enter a branch code: one seat on it, the same as signing up with it. Their
// listings, times and bookings all stay.
export async function handleAddCode(req, res, body) {
  const user = await requireUser(req, res);
  if (!user) return;
  const agent = await ownAgent(user);
  if (!agent) return res.status(404).json({ error: "No agent profile on this account" });
  if (agent.signup_code) return res.status(200).json({ success: true, already: true });
  // Older agents without a code (the legacy single sign-up code) are billed
  // their own way: moving them onto a branch is done by hand on /admin.
  if (!agent.trial_ends_at) {
    return res.status(409).json({ error: `Please email ${CONTACT_EMAIL} to move your account onto a branch code.` });
  }

  const code = normaliseCode(body.code);
  const found = await lookUpCode(code);
  if (!found) return res.status(403).json({ error: CODE_ERROR });
  if (found.full) return res.status(409).json({ error: fullError(found), full: true });

  const { data: agency, error } = await supabaseAdmin.rpc("convert_trial_agent", { p_agent: user.id, p_code: code });
  if (error || !agency) {
    if (error) console.error("convert_trial_agent failed:", error);
    // Someone took the last seat a moment ago, or it was switched off.
    const again = await lookUpCode(code);
    return again?.full
      ? res.status(409).json({ error: fullError(again), full: true })
      : res.status(403).json({ error: CODE_ERROR });
  }
  return res.status(200).json({ success: true, agency, branch: found.branch });
}

// "Get a code for your branch": tells us, with their details. Trial agents
// typed their agency and branch themselves and bill as a branch of one, so
// letting them correct those here changes nothing about billing.
export async function handleRequestCode(req, res, body) {
  const user = await requireUser(req, res);
  if (!user) return;
  const agent = await ownAgent(user);
  if (!agent) return res.status(404).json({ error: "No agent profile on this account" });
  if (agent.signup_code) return res.status(200).json({ success: true, already: true });

  const details = {
    agency: clean(body.agency, 100) || agent.agency,
    branch: clean(body.branch, 100) || agent.branch || null,
    phone: clean(body.phone, 40) || agent.phone || null,
  };
  const recently =
    agent.code_requested_at && Date.now() - new Date(agent.code_requested_at).getTime() < DAY;
  const { error } = await supabaseAdmin
    .from("agents")
    .update({ ...details, code_requested_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("signup_code", null);
  if (error) {
    console.error("code request failed:", error);
    return res.status(500).json({ error: "Could not send your request. Please try again." });
  }
  // One email to us a day, however often it's pressed. It also shows on
  // /admin under Trials either way.
  if (!recently) {
    const rows = [
      ["Name", agent.name],
      ["Agency", details.agency],
      ["Branch", details.branch],
      ["Phone", details.phone],
      ["Email", agent.email],
      ["Trial ends", agent.trial_ends_at ? new Date(agent.trial_ends_at).toLocaleDateString("en-GB") : ""],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">${k}</td><td>${escapeHtml(v)}</td></tr>`)
      .join("");
    const result = await sendEmail({
      to: process.env.ADMIN_EMAIL || CONTACT_EMAIL,
      replyTo: agent.email,
      subject: `Branch code request: ${[details.agency, details.branch].filter(Boolean).join(" · ")}`,
      html: emailLayout(
        "A trial agent wants a branch code",
        `<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px;">${rows}</table>
        <p style="margin:0;">Make it on <a href="${escapeHtml(appBaseUrl(req))}/admin" style="color:#223a33;">/admin</a> under Trials.</p>`
      ),
    });
    if (result?.sent === false) console.error("Code request email not sent (request saved).");
  }
  return res.status(200).json({ success: true, requested: true });
}

// After admin_make_trial_code on /admin: email the agent their code.
export async function handleAdminCodeEmail(req, res, body) {
  const user = await requireUser(req, res);
  if (!user) return;
  const { data: admin } = await supabaseAdmin.from("app_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!admin) return res.status(404).json({ error: "Not found" });

  if (!UUID_RE.test(String(body.agentId || ""))) return res.status(400).json({ error: "Which agent?" });
  const { data: agent } = await supabaseAdmin
    .from("agents")
    .select("name, email, agency, branch, signup_code")
    .eq("user_id", body.agentId)
    .maybeSingle();
  if (!agent?.signup_code) return res.status(400).json({ error: "That agent has no branch code yet" });

  const base = appBaseUrl(req);
  const joinUrl = `${base}/agent?code=${encodeURIComponent(agent.signup_code)}`;
  const result = await sendEmail({
    to: agent.email,
    subject: "Your PropertySearch branch code",
    html: emailLayout(
      "Your branch code",
      `<p style="font-size:15px;line-height:1.5;margin:0 0 12px;">Hi ${escapeHtml(firstWord(agent.name))},</p>
      <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">Your account is now on the code for
      <strong>${escapeHtml([agent.agency, agent.branch].filter(Boolean).join(" · "))}</strong>.
      Your trial is over and nothing else changes: your listings and bookings stay, and buyers can keep booking.</p>
      <p style="font-size:22px;font-weight:bold;letter-spacing:1px;margin:0 0 16px;color:#223a33;">${escapeHtml(agent.signup_code)}</p>
      <p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Colleagues at your branch can join with this link:</p>
      <p style="margin:0 0 20px;">${button(joinUrl, "Branch sign-up link")}</p>
      <p style="font-size:13px;line-height:1.5;color:#6b7280;margin:0;">Questions? Email
      <a href="mailto:${CONTACT_EMAIL}" style="color:#223a33;">${CONTACT_EMAIL}</a>.</p>`
    ),
  });
  return res.status(200).json({ success: true, emailed: Boolean(result?.sent) });
}
