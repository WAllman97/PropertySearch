// Shared by /api/viewings (signed-in buyers) and /api/listing-viewings
// (guests booking through an agent's share link).
import { supabaseAdmin } from "./household.js";
import { buildIcs, emailLayout, escapeHtml, sendEmail } from "./email.js";
import { formatLondon } from "./time.js";
import { sendToUsers } from "./push.js";

export const BOOKING_ERRORS = {
  SLOT_GONE: [410, "Sorry, the agent has removed that time."],
  SLOT_PAST: [410, "That time has already passed."],
  SLOT_FULL: [409, "Sorry, that time has just been taken. Please pick another."],
  ALREADY_BOOKED: [409, "You already have a viewing booked for this property."],
  LISTING_CLOSED: [410, "Sorry, this home is no longer taking viewings (it's sold or off the market)."],
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
//   inCalendar: signed-in buyers get it in their ViewPal calendar
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

  const source = inCalendar ? "through ViewPal" : "through your ViewPal booking link";

  await Promise.all([
    // The agent's phone too (when they use the iPhone app).
    sendToUsers([slot.agent_id], {
      title: "New viewing booked",
      body: `${buyer.name}: ${address}, ${when}`,
      url: "/agent",
    }).catch((error) => console.error("Agent booking push failed:", error)),
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
            ? `It's in your ViewPal calendar, and you'll get a reminder the day before.${
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

  // Move the home along to "Viewing booked", so the buyer doesn't have to.
  // Only from the early stages: never undo "Viewed" or an offer.
  const { error: stageError } = await supabaseAdmin
    .from("properties")
    .update({ status: "viewing_booked" })
    .eq("id", propertyId)
    .or("status.is.null,status.in.(new,favourite)");
  if (stageError) console.error("Could not set Viewing booked:", stageError);
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

// The calendar update that removes a cancelled viewing (same event as the
// invite sent at booking, whose UID is the booking id).
export function cancelledIcs(slot, bookingId) {
  return buildIcs({
    uid: bookingId,
    start: new Date(slot.starts_at),
    end: new Date(slot.ends_at),
    summary: `Cancelled: viewing at ${slot.agent_listings.address}`,
    description: "This viewing has been cancelled.",
    location: slot.agent_listings.address,
    cancelled: true,
  });
}

// "Pick another time": the listing's booking page, with the buyer's own
// one-tap link if the agent sent them this home (migration 025).
async function rebookUrl(slot, booking, base) {
  let token = null;
  if (booking.buyer_id) {
    const { data } = await supabaseAdmin
      .from("listing_sends")
      .select("book_token")
      .eq("listing_id", slot.listing_id)
      .eq("user_id", booking.buyer_id)
      .maybeSingle();
    token = data?.book_token || null;
  }
  return `${base}/viewings/${slot.listing_id}${token ? `?b=${token}` : ""}`;
}

// The agent cancelled a buyer's viewing: tell them, take it out of their
// calendar, and give them one tap to pick another time.
// agentLeft: the agent is deleting their account, so their listing page is
// about to disappear; say so instead of linking to a dead rebooking page.
export async function sendCancelledToBuyer({ slot, booking, base, agentLeft = false }) {
  const address = slot.agent_listings.address;
  const when = slotLabel(slot);
  const agent = slot.agents;
  const status = slot.agent_listings.market_status;
  const stillOn = !status || status === "available" || status === "under_offer";
  const url = stillOn && base && !agentLeft ? await rebookUrl(slot, booking, base) : null;
  const why = agentLeft
    ? " The agent has left ViewPal, so please contact them directly to arrange another viewing."
    : stillOn
      ? ""
      : " The home is no longer on the market.";

  return sendEmail({
    to: booking.buyer_email,
    replyTo: agent.email,
    subject: `Viewing cancelled: ${address}, ${when}`,
    html: emailLayout(
      "Your viewing has been cancelled",
      `<p style="margin:0 0 16px;">${escapeHtml(agentLabel(agent))} has cancelled the viewing of
      <strong>${escapeHtml(address)}</strong> on ${escapeHtml(when)}.${why} The attached update takes it out of your calendar.</p>
      ${
        url
          ? `<p style="margin:0 0 16px;"><a href="${escapeHtml(url)}" style="background:#223a33;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">Pick another time</a></p>`
          : ""
      }
      <p style="margin:0;color:#6b7280;font-size:13px;">Reply to this email to contact the agent.</p>`
    ),
    ics: cancelledIcs(slot, booking.id),
  });
}

// The agent withdraws a time: cancel it and every booking on it, and tell
// each buyer. Used by "Cancel time" and by agent account deletion.
// Returns how many bookings were cancelled.
// agentLeft: account deletion; buyers are told the agent has gone and get no
// rebooking link (see sendCancelledToBuyer).
export async function cancelSlotAndNotify(slot, base, { notifyAgent = true, agentLeft = false } = {}) {
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
      await sendCancelledToBuyer({ slot, booking, base, agentLeft });
    })
  );
  // The agent's own diary entries go too (not when they're deleting their
  // account: there's no diary to keep tidy).
  await Promise.all(
    (notifyAgent ? cancelled || [] : []).map((booking) =>
      sendEmail({
        to: agent.email,
        subject: `Removed from your diary: ${address}, ${when}`,
        html: emailLayout(
          "Viewing cancelled",
          `<p style="margin:0;">You cancelled ${escapeHtml(booking.buyer_name)}'s viewing of
          <strong>${escapeHtml(address)}</strong> on ${escapeHtml(when)}. The attached update
          removes it from your calendar.</p>`
        ),
        ics: cancelledIcs(slot, booking.id),
      })
    )
  );

  return cancelled?.length || 0;
}

// A buyer deleting their account: cancel each of their upcoming bookings the
// way a buyer cancel does (same status change, calendar clear-up, agent push
// and email with the calendar removal), so the agent isn't left with a
// viewing that silently vanished when the booking row cascades away.
// No email to the buyer: they're leaving. Returns how many were cancelled.
export async function cancelBuyerBookingsForDeletion(userId) {
  const now = new Date().toISOString();
  const { data: bookings } = await supabaseAdmin
    .from("viewing_bookings")
    .select("*")
    .eq("buyer_id", userId)
    .eq("status", "confirmed");

  let count = 0;
  for (const booking of bookings || []) {
    const slot = await loadSlot(booking.slot_id);
    // Past viewings need no cancellation; a withdrawn time already told the agent.
    if (!slot || slot.cancelled_at || new Date(slot.starts_at).getTime() <= Date.now()) continue;

    const { data: updated } = await supabaseAdmin
      .from("viewing_bookings")
      .update({ status: "cancelled", cancelled_by: "buyer", cancelled_at: now })
      .eq("id", booking.id)
      .eq("status", "confirmed")
      .select("id");
    if (!updated?.length) continue;
    count += 1;

    await clearCalendarViewing(booking.property_id, slot);

    const address = slot.agent_listings.address;
    const when = slotLabel(slot);
    await Promise.all([
      sendToUsers([slot.agent_id], {
        title: "Viewing cancelled",
        body: `${booking.buyer_name} cancelled ${address}, ${when}`,
        url: "/agent",
      }).catch((error) => console.error("Agent cancel push failed:", error)),
      sendEmail({
        to: slot.agents.email,
        replyTo: booking.buyer_email,
        subject: `Viewing cancelled: ${address}, ${when}`,
        html: emailLayout(
          "Viewing cancelled by the buyer",
          `<p style="margin:0;">${escapeHtml(booking.buyer_name)} has cancelled their viewing of
          <strong>${escapeHtml(address)}</strong> on ${escapeHtml(when)}. The space is free again,
          and the attached update takes it out of your calendar.</p>`
        ),
        ics: cancelledIcs(slot, booking.id),
      }),
    ]);
  }
  return count;
}
