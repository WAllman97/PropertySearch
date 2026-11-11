// Public booking endpoint used by agents (no login).
//   GET  /api/booking?slug=will-a  -> buyer's display name + free slots
//   POST /api/booking              -> request a call or viewing in a slot
//
// Only the buyer's display name, intro and free/busy slots are exposed. The
// buyer's phone and email are never returned here; the agent gets the phone
// number only in the confirmation email once the buyer accepts.
import { supabaseAdmin, underRateLimit } from "./_lib/household.js";
import { appBaseUrl, getFreeSlots, loadActivePage } from "./_lib/booking.js";
import { emailLayout, escapeHtml, sendEmail } from "./_lib/email.js";
import { formatLondon } from "./_lib/time.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_REQUESTS_PER_DAY = 30; // per buyer, protects them from form spam

const LIMITS = {
  agentName: 100,
  agentEmail: 254,
  agentPhone: 40,
  agency: 100,
  propertyAddress: 200,
  propertyUrl: 500,
  message: 1000,
};

function cleanString(value, max) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > max ? null : trimmed;
}

async function handleGet(req, res) {
  const page = await loadActivePage(req.query.slug);

  if (!page) {
    return res.status(404).json({ error: "Booking page not found" });
  }

  const slots = await getFreeSlots(page);

  return res.status(200).json({
    page: {
      displayName: page.display_name,
      intro: page.intro,
      slotMinutes: page.slot_minutes,
    },
    slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
  });
}

async function handlePost(req, res) {
  const body = req.body || {};

  // Honeypot: real users never see or fill this field.
  if (body.website) {
    return res.status(200).json({ success: true });
  }

  const fields = {};
  for (const [key, max] of Object.entries(LIMITS)) {
    fields[key] = cleanString(body[key], max);
    if (fields[key] === null) {
      return res.status(400).json({ error: `${key} is too long or invalid` });
    }
  }

  const kind = body.kind === "viewing" ? "viewing" : body.kind === "call" ? "call" : null;

  if (!kind) {
    return res.status(400).json({ error: "Choose a call or a viewing" });
  }

  if (!fields.agentName) {
    return res.status(400).json({ error: "Please add your name" });
  }

  if (!EMAIL_RE.test(fields.agentEmail)) {
    return res.status(400).json({ error: "Please add a valid email address" });
  }

  if (fields.propertyUrl && !/^https?:\/\//i.test(fields.propertyUrl)) {
    return res.status(400).json({ error: "The property link must start with http(s)://" });
  }

  if (kind === "viewing" && !fields.propertyAddress && !fields.propertyUrl) {
    return res.status(400).json({ error: "For a viewing, add the property address or link" });
  }

  const page = await loadActivePage(body.slug);

  if (!page) {
    return res.status(404).json({ error: "Booking page not found" });
  }

  // The requested time must be one of the slots we'd offer right now. This
  // rejects made-up times, past times and anything already taken.
  const requested = new Date(body.startsAt);
  const slots = await getFreeSlots(page);
  const slot = slots.find((s) => s.start.getTime() === requested.getTime());

  if (!slot) {
    return res.status(409).json({ error: "That time is no longer available. Please pick another." });
  }

  if (!(await underRateLimit(page.user_id, "public_booking_request", MAX_REQUESTS_PER_DAY, 24 * 60))) {
    return res.status(429).json({ error: "Too many requests today. Please try again tomorrow." });
  }

  const { data: created, error } = await supabaseAdmin
    .from("booking_requests")
    .insert({
      user_id: page.user_id,
      kind,
      starts_at: slot.start.toISOString(),
      ends_at: slot.end.toISOString(),
      agent_name: fields.agentName,
      agent_email: fields.agentEmail,
      agent_phone: fields.agentPhone || null,
      agency: fields.agency || null,
      property_address: fields.propertyAddress || null,
      property_url: fields.propertyUrl || null,
      message: fields.message || null,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = the unique index caught two agents taking the same slot.
    if (error.code === "23505") {
      return res.status(409).json({ error: "That time was just taken. Please pick another." });
    }
    console.error("booking insert failed:", error);
    return res.status(500).json({ error: "Could not save your request" });
  }

  // Tell the buyer (only the buyer: this public form must never be able to
  // send email to an address the visitor typed in).
  const { data: buyer } = await supabaseAdmin.auth.admin.getUserById(page.user_id);
  const buyerEmail = buyer?.user?.email;

  if (buyerEmail) {
    const what = kind === "viewing" ? "a viewing" : "a call";
    const when = formatLondon(slot.start);
    const details = [
      `<p style="margin:0 0 12px;"><strong>${escapeHtml(fields.agentName)}</strong>${
        fields.agency ? ` from ${escapeHtml(fields.agency)}` : ""
      } has asked for ${what} on <strong>${escapeHtml(when)}</strong>.</p>`,
      fields.propertyAddress ? `<p style="margin:0 0 8px;">Property: ${escapeHtml(fields.propertyAddress)}</p>` : "",
      fields.propertyUrl ? `<p style="margin:0 0 8px;"><a href="${escapeHtml(fields.propertyUrl)}">View listing</a></p>` : "",
      fields.message ? `<p style="margin:0 0 12px;color:#6b7280;">"${escapeHtml(fields.message)}"</p>` : "",
      `<p style="margin:16px 0 0;"><a href="${appBaseUrl(req)}/?view=calendar" style="background:#223a33;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">Accept or decline</a></p>`,
    ].join("");

    await sendEmail({
      to: buyerEmail,
      subject: `${fields.agentName} requested ${what}: ${when}`,
      html: emailLayout(`New ${kind} request`, details),
    });
  }

  return res.status(200).json({ success: true, id: created.id });
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "POST") return await handlePost(req, res);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
}
