// Viewing bookings against agents' published slots (migration 006).
//   POST /api/viewings { action: "book", slotId, propertyId, phone }   buyer
//   POST /api/viewings { action: "cancel", bookingId }                  buyer or agent
//   POST /api/viewings { action: "cancel_slot", slotId }                agent
//
// Booking is instant: book_viewing() locks the slot so the last space can't
// be taken twice. Each change emails both sides and keeps the buyer's app
// calendar (property_notes) in step, which also drives the reminder emails.
import { requireHouseholdUser, requireUser, supabaseAdmin, underRateLimit } from "./_lib/household.js";
import { appBaseUrl } from "./_lib/booking.js";
import { buildIcs, emailLayout, escapeHtml, sendEmail } from "./_lib/email.js";
import { listingKey } from "./_lib/listing.js";
import { formatLondon } from "./_lib/time.js";

const MAX_BOOKINGS_PER_DAY = 20;

const BOOKING_ERRORS = {
  SLOT_GONE: [410, "Sorry, the agent has removed that time."],
  SLOT_PAST: [410, "That time has already passed."],
  SLOT_FULL: [409, "Sorry, that time has just been taken. Please pick another."],
  ALREADY_BOOKED: [409, "You already have a viewing booked for this property."],
};

function slotLabel(slot) {
  const start = new Date(slot.starts_at);
  const end = new Date(slot.ends_at);
  return `${formatLondon(start)}–${formatLondon(end, { weekday: undefined, day: undefined, month: undefined })}`;
}

function agentLabel(agent) {
  return [agent.name, [agent.agency, agent.branch].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
}

function detailRow(label, value) {
  if (!value) return "";
  return `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">${escapeHtml(label)}</td><td style="padding:4px 0;">${value}</td></tr>`;
}

// Slot + listing + agent in one go (service role).
async function loadSlot(slotId) {
  const { data } = await supabaseAdmin
    .from("viewing_slots")
    .select("*, agent_listings(*), agents(*)")
    .eq("id", slotId)
    .maybeSingle();
  return data;
}

async function buyerIdentity(user) {
  const { data: page } = await supabaseAdmin
    .from("booking_pages")
    .select("display_name, phone")
    .eq("user_id", user.id)
    .maybeSingle();

  const meta = user.user_metadata || {};
  return {
    name: page?.display_name || meta.full_name || meta.name || user.email.split("@")[0],
    phone: page?.phone || "",
  };
}

// Put the viewing in the household calendar, or take it out again.
async function setCalendarViewing(propertyId, slot, agent) {
  if (!propertyId) return;
  const { error } = await supabaseAdmin.from("property_notes").upsert(
    {
      property_id: propertyId,
      viewing_datetime: slot.starts_at,
      estate_agent: agentLabel(agent),
      estate_agent_email: agent.email,
      estate_agent_phone: agent.phone,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "property_id" }
  );
  if (error) console.error("Could not add viewing to calendar:", error);
}

async function clearCalendarViewing(propertyId, slot) {
  if (!propertyId) return;
  const { error } = await supabaseAdmin
    .from("property_notes")
    .update({ viewing_datetime: null, updated_at: new Date().toISOString() })
    .eq("property_id", propertyId)
    .eq("viewing_datetime", slot.starts_at);
  if (error) console.error("Could not clear calendar viewing:", error);
}

async function handleBook(req, res) {
  const user = await requireHouseholdUser(req, res);
  if (!user) return;

  const { slotId, propertyId } = req.body || {};
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim().slice(0, 40) : "";

  if (typeof slotId !== "string" || typeof propertyId !== "string") {
    return res.status(400).json({ error: "Missing slot or property" });
  }

  const [slot, { data: property }] = await Promise.all([
    loadSlot(slotId),
    supabaseAdmin
      .from("properties")
      .select("id, address, listing_url")
      .eq("id", propertyId)
      .maybeSingle(),
  ]);

  // The slot must belong to a listing for this exact saved home.
  if (
    !slot ||
    !property ||
    !slot.agent_listings?.is_active ||
    listingKey(property.listing_url) !== slot.agent_listings.listing_key
  ) {
    return res.status(404).json({ error: "That viewing time isn't available" });
  }

  if (!(await underRateLimit(user.id, "viewing_book", MAX_BOOKINGS_PER_DAY, 24 * 60))) {
    return res.status(429).json({ error: "Too many bookings today. Please try again tomorrow." });
  }

  const identity = await buyerIdentity(user);
  const buyerPhone = phone || identity.phone;

  const { data: bookingId, error } = await supabaseAdmin.rpc("book_viewing", {
    p_slot: slot.id,
    p_buyer: user.id,
    p_name: identity.name,
    p_email: user.email,
    p_phone: buyerPhone,
    p_property: property.id,
  });

  if (error) {
    const known = Object.keys(BOOKING_ERRORS).find((code) => error.message?.includes(code));
    if (known) {
      const [status, message] = BOOKING_ERRORS[known];
      return res.status(status).json({ error: message });
    }
    console.error("book_viewing failed:", error);
    return res.status(500).json({ error: "Could not book that viewing. Please try again." });
  }

  const listing = slot.agent_listings;
  const agent = slot.agents;
  const when = slotLabel(slot);
  const address = listing.address || property.address;
  const isOpenHouse = slot.capacity > 1;

  await setCalendarViewing(property.id, slot, agent);

  const ics = (summary, description) =>
    buildIcs({
      uid: bookingId,
      start: new Date(slot.starts_at),
      end: new Date(slot.ends_at),
      summary,
      description,
      location: address,
    });

  const { count: booked } = await supabaseAdmin
    .from("viewing_bookings")
    .select("id", { count: "exact", head: true })
    .eq("slot_id", slot.id)
    .eq("status", "confirmed");

  const base = appBaseUrl(req);

  await Promise.all([
    sendEmail({
      to: agent.email,
      replyTo: user.email,
      subject: `Viewing booked: ${address}, ${when}`,
      html: emailLayout(
        "New viewing booked",
        `<p style="margin:0 0 12px;">${escapeHtml(identity.name)} has booked a viewing through PropertySearch.</p>
        <table style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">
          ${detailRow("Property", escapeHtml(address))}
          ${detailRow("When", escapeHtml(when))}
          ${isOpenHouse ? detailRow("Open house", `${booked ?? "?"} of ${slot.capacity} spaces booked`) : ""}
          ${detailRow("Buyer", escapeHtml(identity.name))}
          ${detailRow("Phone", escapeHtml(buyerPhone))}
          ${detailRow("Email", `<a href="mailto:${escapeHtml(user.email)}">${escapeHtml(user.email)}</a>`)}
        </table>
        <p style="margin:0;"><a href="${escapeHtml(base)}/agent" style="color:#223a33;font-weight:bold;">See all your viewings</a></p>`
      ),
      ics: ics(`Viewing: ${address} (${identity.name})`, [
        `Buyer: ${identity.name}`,
        buyerPhone ? `Phone: ${buyerPhone}` : "",
        `Email: ${user.email}`,
      ].filter(Boolean).join("\n")),
    }),
    sendEmail({
      to: user.email,
      replyTo: agent.email,
      subject: `Viewing confirmed: ${address}, ${when}`,
      html: emailLayout(
        "Your viewing is booked",
        `<table style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">
          ${detailRow("Property", escapeHtml(address))}
          ${detailRow("When", escapeHtml(when))}
          ${isOpenHouse ? detailRow("Type", "Open house") : ""}
          ${detailRow("Agent", escapeHtml(agentLabel(agent)))}
          ${detailRow("Agent phone", escapeHtml(agent.phone))}
          ${detailRow("Notes", escapeHtml(listing.notes))}
        </table>
        <p style="margin:0;">It's in your PropertySearch calendar, and you'll get a reminder the day before.</p>`
      ),
      ics: ics(`Viewing: ${address}`, [
        `Agent: ${agentLabel(agent)}`,
        agent.phone ? `Phone: ${agent.phone}` : "",
        listing.notes || "",
      ].filter(Boolean).join("\n")),
    }),
  ]);

  return res.status(200).json({ success: true, bookingId });
}

// Cancel one booking. Buyers cancel their own; agents cancel any on their slots.
async function handleCancel(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const { bookingId } = req.body || {};
  if (typeof bookingId !== "string") {
    return res.status(400).json({ error: "Missing booking" });
  }

  const { data: booking } = await supabaseAdmin
    .from("viewing_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();

  const slot = booking ? await loadSlot(booking.slot_id) : null;

  const by =
    booking?.buyer_id === user.id ? "buyer" : slot?.agent_id === user.id ? "agent" : null;

  if (!booking || !slot || !by) {
    return res.status(404).json({ error: "Booking not found" });
  }

  const { data: updated } = await supabaseAdmin
    .from("viewing_bookings")
    .update({ status: "cancelled", cancelled_by: by, cancelled_at: new Date().toISOString() })
    .eq("id", booking.id)
    .eq("status", "confirmed")
    .select("id");

  if (!updated?.length) {
    return res.status(409).json({ error: "This booking was already cancelled" });
  }

  await clearCalendarViewing(booking.property_id, slot);

  const address = slot.agent_listings.address;
  const when = slotLabel(slot);
  const agent = slot.agents;

  if (by === "buyer") {
    await sendEmail({
      to: agent.email,
      replyTo: booking.buyer_email,
      subject: `Viewing cancelled: ${address}, ${when}`,
      html: emailLayout(
        "Viewing cancelled by the buyer",
        `<p style="margin:0;">${escapeHtml(booking.buyer_name)} has cancelled their viewing of
        <strong>${escapeHtml(address)}</strong> on ${escapeHtml(when)}. The space is free again.</p>`
      ),
    });
  } else {
    await sendEmail({
      to: booking.buyer_email,
      replyTo: agent.email,
      subject: `Viewing cancelled: ${address}, ${when}`,
      html: emailLayout(
        "Your viewing has been cancelled",
        `<p style="margin:0;">${escapeHtml(agentLabel(agent))} has cancelled your viewing of
        <strong>${escapeHtml(address)}</strong> on ${escapeHtml(when)}. You can pick another
        time in PropertySearch, or reply to this email to contact the agent.</p>`
      ),
    });
  }

  return res.status(200).json({ success: true });
}

// Agent removes a time: cancels everyone booked into it and tells them.
async function handleCancelSlot(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const { slotId } = req.body || {};
  const slot = typeof slotId === "string" ? await loadSlot(slotId) : null;

  if (!slot || slot.agent_id !== user.id) {
    return res.status(404).json({ error: "Viewing time not found" });
  }

  if (slot.cancelled_at) {
    return res.status(200).json({ success: true });
  }

  await supabaseAdmin
    .from("viewing_slots")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("id", slot.id);

  const { data: cancelled } = await supabaseAdmin
    .from("viewing_bookings")
    .update({ status: "cancelled", cancelled_by: "agent", cancelled_at: new Date().toISOString() })
    .eq("slot_id", slot.id)
    .eq("status", "confirmed")
    .select("*");

  const address = slot.agent_listings.address;
  const when = slotLabel(slot);
  const agent = slot.agents;

  await Promise.all(
    (cancelled || []).map(async (booking) => {
      await clearCalendarViewing(booking.property_id, slot);
      await sendEmail({
        to: booking.buyer_email,
        replyTo: agent.email,
        subject: `Viewing cancelled: ${address}, ${when}`,
        html: emailLayout(
          "Your viewing has been cancelled",
          `<p style="margin:0;">${escapeHtml(agentLabel(agent))} has cancelled the viewing of
          <strong>${escapeHtml(address)}</strong> on ${escapeHtml(when)}. You can pick another
          time in PropertySearch, or reply to this email to contact the agent.</p>`
        ),
      });
    })
  );

  return res.status(200).json({ success: true, cancelledBookings: cancelled?.length || 0 });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const action = req.body?.action;

  if (action === "book") return handleBook(req, res);
  if (action === "cancel") return handleCancel(req, res);
  if (action === "cancel_slot") return handleCancelSlot(req, res);

  return res.status(400).json({ error: "Unknown action" });
}
