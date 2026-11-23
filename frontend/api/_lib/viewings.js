// Shared by /api/viewings (signed-in buyers) and /api/listing-viewings
// (guests booking through an agent's share link).
import { supabaseAdmin } from "./household.js";
import { buildIcs, emailLayout, escapeHtml, sendEmail } from "./email.js";
import { formatLondon } from "./time.js";

export const BOOKING_ERRORS = {
  SLOT_GONE: [410, "Sorry, the agent has removed that time."],
  SLOT_PAST: [410, "That time has already passed."],
  SLOT_FULL: [409, "Sorry, that time has just been taken. Please pick another."],
  ALREADY_BOOKED: [409, "You already have a viewing booked for this property."],
};

export function slotLabel(slot) {
  const start = new Date(slot.starts_at);
  const end = new Date(slot.ends_at);
  return `${formatLondon(start)}–${formatLondon(end, { weekday: undefined, day: undefined, month: undefined })}`;
}

export function agentLabel(agent) {
  return [agent.name, [agent.agency, agent.branch].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
}

export function detailRow(label, value) {
  if (!value) return "";
  return `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">${escapeHtml(label)}</td><td style="padding:4px 0;">${value}</td></tr>`;
}

// Slot + listing + agent in one go (service role).
export async function loadSlot(slotId) {
  const { data } = await supabaseAdmin
    .from("viewing_slots")
    .select("*, agent_listings(*), agents(*)")
    .eq("id", slotId)
    .maybeSingle();
  return data;
}

// Booking emails to the agent and the buyer, each with a calendar invite.
//   buyer: { name, email, phone }
//   inCalendar: signed-in buyers get it in their PropertySearch calendar
//   cancelUrl: guests cancel with this private link
export async function sendBookingEmails({ slot, bookingId, buyer, base, inCalendar, cancelUrl }) {
  const listing = slot.agent_listings;
  const agent = slot.agents;
  const when = slotLabel(slot);
  const address = listing.address;
  const isOpenHouse = slot.capacity > 1;

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

  const source = inCalendar ? "through PropertySearch" : "through your PropertySearch booking link";

  await Promise.all([
    sendEmail({
      to: agent.email,
      replyTo: buyer.email,
      subject: `Viewing booked: ${address}, ${when}`,
      html: emailLayout(
        "New viewing booked",
        `<p style="margin:0 0 12px;">${escapeHtml(buyer.name)} has booked a viewing ${source}.</p>
        <table style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">
          ${detailRow("Property", escapeHtml(address))}
          ${detailRow("When", escapeHtml(when))}
          ${isOpenHouse ? detailRow("Open house", `${booked ?? "?"} of ${slot.capacity} spaces booked`) : ""}
          ${detailRow("Buyer", escapeHtml(buyer.name))}
          ${detailRow("Phone", escapeHtml(buyer.phone))}
          ${detailRow("Email", `<a href="mailto:${escapeHtml(buyer.email)}">${escapeHtml(buyer.email)}</a>`)}
        </table>
        <p style="margin:0;"><a href="${escapeHtml(base)}/agent" style="color:#223a33;font-weight:bold;">See all your viewings</a></p>`
      ),
      ics: ics(`Viewing: ${address} (${buyer.name})`, [
        `Buyer: ${buyer.name}`,
        buyer.phone ? `Phone: ${buyer.phone}` : "",
        `Email: ${buyer.email}`,
      ].filter(Boolean).join("\n")),
    }),
    sendEmail({
      to: buyer.email,
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
        <p style="margin:0;">${
          inCalendar
            ? `It's in your PropertySearch calendar, and you'll get a reminder the day before.${
                cancelUrl
                  ? ` Can't make it? <a href="${escapeHtml(cancelUrl)}" style="color:#223a33;font-weight:bold;">Cancel this viewing</a>.`
                  : ""
              }`
            : `The calendar invite is attached. Can't make it?
               <a href="${escapeHtml(cancelUrl)}" style="color:#223a33;font-weight:bold;">Cancel this viewing</a>
               so someone else can have the time.`
        }</p>`
      ),
      ics: ics(`Viewing: ${address}`, [
        `Agent: ${agentLabel(agent)}`,
        agent.phone ? `Phone: ${agent.phone}` : "",
        listing.notes || "",
      ].filter(Boolean).join("\n")),
    }),
  ]);
}

// The name and phone a buyer books under: their booking page details, else
// what they signed up with.
export async function buyerIdentity(user) {
  const { data: page } = await supabaseAdmin
    .from("booking_pages")
    .select("display_name, phone")
    .eq("user_id", user.id)
    .maybeSingle();

  const meta = user.user_metadata || {};
  return {
    name: page?.display_name || meta.full_name || meta.name || user.email.split("@")[0],
    phone: page?.phone || meta.phone || "",
  };
}

// Put a booked viewing in the household calendar.
export async function setCalendarViewing(propertyId, slot, agent) {
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

// Take a booked viewing back out of the household calendar.
export async function clearCalendarViewing(propertyId, slot) {
  if (!propertyId) return;
  const { error } = await supabaseAdmin
    .from("property_notes")
    .update({ viewing_datetime: null, updated_at: new Date().toISOString() })
    .eq("property_id", propertyId)
    .eq("viewing_datetime", slot.starts_at);
  if (error) console.error("Could not clear calendar viewing:", error);
}

// The agent withdraws a time: cancel it and every booking on it, and tell
// each buyer. Used by "Cancel time" and by agent account deletion.
// Returns how many bookings were cancelled.
export async function cancelSlotAndNotify(slot) {
  const now = new Date().toISOString();

  await supabaseAdmin.from("viewing_slots").update({ cancelled_at: now }).eq("id", slot.id);

  const { data: cancelled } = await supabaseAdmin
    .from("viewing_bookings")
    .update({ status: "cancelled", cancelled_by: "agent", cancelled_at: now })
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

  return cancelled?.length || 0;
}
