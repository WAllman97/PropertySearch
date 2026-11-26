// Setup calls (migration 038): agents book their 10-minute call with ViewPal
// themselves, like buyers book viewings. Actions on /api/agent-signup (the
// 12-route limit):
//
//   signed-in agent:
//     { action: "call_slots", withSlots? } -> { active, slotMinutes, video, phone, slots: [iso], call }
//     { action: "book_call", startsAt, kind: "phone"|"video", phone?, note? }
//          books a time, or moves their upcoming call to it
//     { action: "cancel_call" }
//   admin:
//     { action: "admin_cancel_call", callId }
//     { action: "admin_call_status" }   is the calendar linked and readable?
//
// Free times = the weekly hours on /admin, minus calls already booked, minus
// anything busy in the admin's own calendar (CALL_CALENDAR_ICS_URL,
// _lib/calendar-feed.js). Each booking emails the agent and us a calendar
// invite; a move sends an update and a cancel withdraws it.
import { requireUser, supabaseAdmin } from "./household.js";
import { appBaseUrl } from "./booking.js";
import { buildIcs, emailLayout, escapeHtml, sendEmail } from "./email.js";
import { formatLondon, generateSlots } from "./time.js";
import { calendarBusy, calendarUrls } from "./calendar-feed.js";

const CONTACT_EMAIL = "hello@viewpal.app";
const adminEmail = () => process.env.ADMIN_EMAIL || CONTACT_EMAIL;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// New bookings per agent per day (each cancel-and-rebook is a new one), and
// moves of one call.
const MAX_CHANGES_PER_DAY = 8;
const MAX_MOVES = 10;

const clean = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const firstWord = (value) => String(value || "").trim().split(/\s+/)[0] || "";
const when = (iso) => formatLondon(new Date(iso), { weekday: "long", month: "long" });

const button = (href, label) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;background:#223a33;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:10px;">${escapeHtml(label)}</a>`;

async function loadSettings() {
  const [{ data: settings, error }, { data: hours }] = await Promise.all([
    supabaseAdmin.from("setup_call_settings").select("*").eq("id", 1).maybeSingle(),
    supabaseAdmin.from("setup_call_hours").select("weekday, start_time, end_time"),
  ]);
  if (error || !settings) return null; // migration 038 not run yet
  return { settings, hours: hours || [] };
}

async function loadAgent(user) {
  const { data } = await supabaseAdmin
    .from("agents")
    .select("user_id, name, email, phone, agency, branch, signup_code, trial_ends_at")
    .eq("user_id", user.id)
    .maybeSingle();
  return data;
}

async function upcomingCall(agentId) {
  const { data } = await supabaseAdmin
    .from("setup_calls")
    .select("*")
    .eq("agent_id", agentId)
    .eq("status", "booked")
    .gt("ends_at", new Date().toISOString())
    .order("starts_at")
    .limit(1)
    .maybeSingle();
  return data;
}

// Free start times (Dates). Throws if the calendar link can't be read.
async function freeSlots({ settings, hours }, { fresh = false, ignoreCallId = null } = {}) {
  const now = new Date();
  const horizon = new Date(now.getTime() + (settings.days_ahead + 1) * 86400000);
  const [{ data: calls }, calendar] = await Promise.all([
    supabaseAdmin
      .from("setup_calls")
      .select("id, starts_at, ends_at")
      .eq("status", "booked")
      .gt("ends_at", now.toISOString())
      .lt("starts_at", horizon.toISOString()),
    calendarBusy(now, horizon, { fresh }),
  ]);
  const busy = [
    ...(calls || [])
      .filter((call) => call.id !== ignoreCallId)
      .map((call) => ({ start: new Date(call.starts_at), end: new Date(call.ends_at) })),
    ...calendar,
  ];
  return generateSlots({ page: settings, windows: hours, busy, now });
}

const publicCall = (call) =>
  call && { id: call.id, startsAt: call.starts_at, endsAt: call.ends_at, kind: call.kind, phone: call.phone };

// withSlots: false just answers "is a call booked?" (no calendar read), for
// the trial banner before the agent opens the picker.
export async function handleCallSlots(req, res, body = {}) {
  const user = await requireUser(req, res);
  if (!user) return;
  const agent = await loadAgent(user);
  if (!agent) return res.status(404).json({ error: "No agent profile on this account" });

  const config = await loadSettings();
  if (!config) return res.status(200).json({ active: false, slots: [] });
  const call = await upcomingCall(agent.user_id);
  const base = {
    active: config.settings.is_active,
    slotMinutes: config.settings.slot_minutes,
    video: Boolean(config.settings.meet_url),
    phone: agent.phone || "",
    call: publicCall(call),
  };
  if (!config.settings.is_active || body.withSlots === false) return res.status(200).json({ ...base, slots: [] });

  try {
    const slots = await freeSlots(config, { ignoreCallId: call?.id });
    return res.status(200).json({ ...base, slots: slots.map((slot) => slot.start.toISOString()) });
  } catch (error) {
    console.error("setup call slots failed:", error);
    return res.status(200).json({ ...base, slots: [], unavailable: true });
  }
}

function details(call, settings, forAdmin, agent) {
  const video = call.kind === "video" && settings.meet_url;
  const how = video
    ? `Video call: ${settings.meet_url}`
    : forAdmin
      ? `Ring ${agent.name || "the agent"} on ${call.phone || agent.phone || "(no number given)"}`
      : `We'll ring you on ${call.phone || "the number on your account"}`;
  return { video, how };
}

function invite(call, settings, agent, { forAdmin, cancelled = false }) {
  const { video, how } = details(call, settings, forAdmin, agent);
  const who = [agent.name, [agent.agency, agent.branch].filter(Boolean).join(" · ")].filter(Boolean).join(", ");
  return buildIcs({
    uid: `setup-call-${call.id}`,
    start: new Date(call.starts_at),
    end: new Date(call.ends_at),
    summary: forAdmin ? `ViewPal setup call: ${who}` : "ViewPal setup call",
    description: [
      how,
      forAdmin && agent.email ? `Email: ${agent.email}` : null,
      forAdmin && call.note ? `Note: ${call.note}` : null,
      forAdmin ? null : `To move or cancel: ${process.env.APP_URL || "https://viewpal.app"}/agent?call=1`,
    ]
      .filter(Boolean)
      .join("\n"),
    location: video ? settings.meet_url : call.kind === "phone" ? "Phone call" : undefined,
    cancelled,
    sequence: cancelled ? call.sequence + 1 : call.sequence,
  });
}

// What changed: "booked" | "moved" | "cancelled".
async function sendCallEmails(req, { call, settings, agent, change, by = "agent" }) {
  const base = appBaseUrl(req);
  const manageUrl = `${base}/agent?call=1`;
  const time = when(call.starts_at);
  const { video, how } = details(call, settings, false, agent);
  const cancelled = change === "cancelled";

  const agentTitle = cancelled
    ? "Your setup call is cancelled"
    : change === "moved"
      ? "Your setup call has moved"
      : "Your setup call is booked";
  const agentBody = cancelled
    ? `<p style="font-size:15px;line-height:1.5;margin:0 0 12px;">Hi ${escapeHtml(firstWord(agent.name))},</p>
       <p style="font-size:15px;line-height:1.5;margin:0 0 16px;">${
         by === "admin" ? "We've had to cancel" : "You cancelled"
       } your ViewPal setup call on <strong>${escapeHtml(time)}</strong>. Pick another time whenever suits you.</p>
       <p style="margin:0 0 20px;">${button(manageUrl, "Pick a new time")}</p>`
    : `<p style="font-size:15px;line-height:1.5;margin:0 0 12px;">Hi ${escapeHtml(firstWord(agent.name))},</p>
       <p style="font-size:15px;line-height:1.5;margin:0 0 12px;"><strong>${escapeHtml(time)}</strong>, about ${
         settings.slot_minutes
       } minutes.</p>
       <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">${
         video
           ? `Join on Google Meet: <a href="${escapeHtml(settings.meet_url)}" style="color:#223a33;">${escapeHtml(settings.meet_url)}</a>`
           : escapeHtml(how) + "."
       }</p>
       <p style="font-size:15px;line-height:1.5;margin:0 0 16px;">We'll set up your branch, show you how buyers book your times, and answer any questions. The invite is attached for your calendar.</p>
       <p style="margin:0 0 20px;">${button(manageUrl, "Move or cancel")}</p>`;

  const agentMail = sendEmail({
    to: agent.email,
    replyTo: CONTACT_EMAIL,
    subject: cancelled ? "Your ViewPal setup call is cancelled" : `Your ViewPal setup call: ${time}`,
    html: emailLayout(
      agentTitle,
      `${agentBody}<p style="font-size:13px;line-height:1.5;color:#6b7280;margin:0;">Questions? Just reply, or email
       <a href="mailto:${CONTACT_EMAIL}" style="color:#223a33;">${CONTACT_EMAIL}</a>.</p>`
    ),
    ics: invite(call, settings, agent, { forAdmin: false, cancelled }),
  });

  // Our copy, even when we cancelled it ourselves on /admin: its
  // cancellation takes the call out of our calendar.
  let adminMail = Promise.resolve(null);
  {
    const branch = [agent.agency, agent.branch].filter(Boolean).join(" · ");
    const rows = [
      ["When", time],
      ["How", details(call, settings, true, agent).how],
      ["Name", agent.name],
      ["Branch", branch],
      ["Email", agent.email],
      ["Trial ends", !agent.signup_code && agent.trial_ends_at ? new Date(agent.trial_ends_at).toLocaleDateString("en-GB") : ""],
      ["Note", call.note],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;vertical-align:top;">${k}</td><td>${escapeHtml(v)}</td></tr>`)
      .join("");
    adminMail = sendEmail({
      to: adminEmail(),
      replyTo: agent.email,
      subject: `Setup call ${cancelled ? "cancelled" : change}: ${agent.name || agent.email}${branch ? `, ${branch}` : ""}`,
      html: emailLayout(
        cancelled ? "A setup call was cancelled" : change === "moved" ? "A setup call moved" : "New setup call booked",
        `<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px;">${rows}</table>
         <p style="margin:0;">All calls are on <a href="${escapeHtml(base)}/admin" style="color:#223a33;">/admin</a> under Setup calls.</p>`
      ),
      ics: invite(call, settings, agent, { forAdmin: true, cancelled }),
    });
  }

  const results = await Promise.allSettled([agentMail, adminMail]);
  for (const result of results) {
    if (result.status === "rejected") console.error("setup call email failed:", result.reason);
  }
}

export async function handleBookCall(req, res, body) {
  const user = await requireUser(req, res);
  if (!user) return;
  const agent = await loadAgent(user);
  if (!agent) return res.status(404).json({ error: "No agent profile on this account" });

  const config = await loadSettings();
  if (!config?.settings.is_active) {
    return res.status(409).json({ error: `Booking calls is paused. Email ${CONTACT_EMAIL} and we'll find a time.` });
  }
  const { settings } = config;

  const start = new Date(String(body.startsAt || ""));
  if (Number.isNaN(start.getTime())) return res.status(400).json({ error: "Please pick a time" });
  const kind = body.kind === "video" && settings.meet_url ? "video" : "phone";
  const phone = clean(body.phone, 40) || agent.phone || "";
  if (kind === "phone" && phone.replace(/\D/g, "").length < 7) {
    return res.status(400).json({ error: "Please add a phone number we can ring" });
  }
  const note = clean(body.note, 500) || null;

  const { count } = await supabaseAdmin
    .from("setup_calls")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agent.user_id)
    .gte("created_at", new Date(Date.now() - 86400000).toISOString());
  if ((count || 0) >= MAX_CHANGES_PER_DAY) {
    return res.status(429).json({ error: `That's a lot of changes today. Email ${CONTACT_EMAIL} and we'll sort a time.` });
  }

  const current = await upcomingCall(agent.user_id);

  // Check the time is still free, with a fresh look at the calendar.
  let slots;
  try {
    slots = await freeSlots(config, { fresh: true, ignoreCallId: current?.id });
  } catch (error) {
    console.error("setup call calendar check failed:", error);
    return res.status(503).json({ error: "We can't check our diary right now. Please try again in a minute." });
  }
  if (!slots.some((slot) => slot.start.getTime() === start.getTime())) {
    return res.status(409).json({ error: "That time has just gone. Please pick another.", taken: true });
  }

  const end = new Date(start.getTime() + settings.slot_minutes * 60000);
  const row = {
    agent_id: agent.user_id,
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    kind,
    phone: phone || null,
    note,
  };

  // A move keeps the same row (so the same calendar event, with a higher
  // SEQUENCE: calendars update it rather than add a second one).
  let saved;
  if (current && current.sequence >= MAX_MOVES) {
    return res.status(429).json({ error: `That call has moved a lot. Email ${CONTACT_EMAIL} and we'll sort a time.` });
  }
  if (current) {
    const { data, error } = await supabaseAdmin
      .from("setup_calls")
      .update({ ...row, sequence: current.sequence + 1, reminder_sent_at: null })
      .eq("id", current.id)
      .eq("status", "booked")
      .select("*")
      .maybeSingle();
    if (error?.code === "23505") return res.status(409).json({ error: "That time has just gone. Please pick another.", taken: true });
    if (error || !data) {
      if (error) console.error("setup call move failed:", error);
      return res.status(500).json({ error: "Could not move your call. Please try again." });
    }
    saved = data;
  } else {
    const { data, error } = await supabaseAdmin.from("setup_calls").insert(row).select("*").single();
    if (error?.code === "23505") return res.status(409).json({ error: "That time has just gone. Please pick another.", taken: true });
    if (error) {
      console.error("setup call insert failed:", error);
      return res.status(500).json({ error: "Could not book your call. Please try again." });
    }
    saved = data;
  }

  // Keep their number for next time (and for the trial banner's form).
  if (phone && phone !== agent.phone) {
    await supabaseAdmin.from("agents").update({ phone }).eq("user_id", agent.user_id);
  }

  await sendCallEmails(req, { call: saved, settings, agent: { ...agent, phone }, change: current ? "moved" : "booked" });
  return res.status(200).json({ success: true, call: publicCall(saved) });
}

async function cancel(req, call, by) {
  const { data, error } = await supabaseAdmin
    .from("setup_calls")
    .update({ status: "cancelled", cancelled_by: by, cancelled_at: new Date().toISOString() })
    .eq("id", call.id)
    .eq("status", "booked")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  const [{ data: agent }, config] = await Promise.all([
    supabaseAdmin
      .from("agents")
      .select("user_id, name, email, phone, agency, branch, signup_code, trial_ends_at")
      .eq("user_id", call.agent_id)
      .maybeSingle(),
    loadSettings(),
  ]);
  // Only calls still to come need an email.
  if (agent && config && new Date(call.starts_at).getTime() > Date.now()) {
    await sendCallEmails(req, { call, settings: config.settings, agent, change: "cancelled", by });
  }
  return true;
}

export async function handleCancelCall(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const call = await upcomingCall(user.id);
  if (!call) return res.status(200).json({ success: true, already: true });
  try {
    await cancel(req, call, "agent");
  } catch (error) {
    console.error("setup call cancel failed:", error);
    return res.status(500).json({ error: "Could not cancel your call. Please try again." });
  }
  return res.status(200).json({ success: true });
}

async function requireAdmin(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  const { data: admin } = await supabaseAdmin.from("app_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!admin) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return user;
}

// For /admin: is the calendar linked, and can we read it? Never returns
// the link itself or what's in the calendar, just a count.
export async function handleAdminCallStatus(req, res) {
  if (!(await requireAdmin(req, res))) return;
  const linked = calendarUrls().length;
  if (!linked) return res.status(200).json({ linked: 0 });
  const now = new Date();
  try {
    const busy = await calendarBusy(now, new Date(now.getTime() + 14 * 86400000), { fresh: true });
    return res.status(200).json({ linked, ok: true, busy: busy.length });
  } catch (error) {
    console.error("calendar check failed:", error);
    return res.status(200).json({ linked, ok: false, error: String(error?.message || error).slice(0, 200) });
  }
}

export async function handleAdminCancelCall(req, res, body) {
  if (!(await requireAdmin(req, res))) return;
  if (!UUID_RE.test(String(body.callId || ""))) return res.status(400).json({ error: "Which call?" });

  const { data: call } = await supabaseAdmin.from("setup_calls").select("*").eq("id", body.callId).maybeSingle();
  if (!call) return res.status(404).json({ error: "Call not found" });
  try {
    await cancel(req, call, "admin");
  } catch (error) {
    console.error("admin setup call cancel failed:", error);
    return res.status(500).json({ error: "Could not cancel the call. Please try again." });
  }
  return res.status(200).json({ success: true });
}
