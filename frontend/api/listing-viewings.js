// Public booking for an agent's share link: /viewings/<listing id>. No login.
//   GET  ?listing=<id>[&b=<token>]     listing, agent and open times; with the
//                                      private token from a "new match" email,
//                                      also that buyer's details to fill in
//   GET  ?cancel=<token>               a guest booking, for the cancel page
//   POST { action: "book", listingId, slotId, name, email, phone, b? }
//   POST { action: "cancel", token }   guest cancels with the link in their email
//
// Only what an agent already advertises is exposed (address, price, their
// name and phone, open times and spaces left). Other buyers' details are
// never returned. Migration 007.
import { supabaseAdmin } from "./_lib/household.js";
import { appBaseUrl } from "./_lib/booking.js";
import { emailLayout, escapeHtml, sendEmail } from "./_lib/email.js";
import {
  BOOKING_ERRORS,
  buyerIdentity,
  cancelledIcs,
  clearCalendarViewing,
  loadSlot,
  sendBookingEmails,
  setCalendarViewing,
  slotLabel,
} from "./_lib/viewings.js";
import { listingKey } from "./_lib/listing.js";
import { withCors } from "./_lib/cors.js";
import { sendToUsers } from "./_lib/push.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Per listing, protects agents from form spam.
const MAX_BOOKINGS_PER_LISTING_PER_HOUR = 40;

function clean(value, max) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > max ? null : trimmed;
}

async function loadListing(listingId) {
  if (!UUID_RE.test(String(listingId || ""))) return null;
  const { data } = await supabaseAdmin
    .from("agent_listings")
    .select("id, address, price, notes, listing_url, is_active, market_status, agents(name, agency, branch, phone)")
    .eq("id", listingId)
    .maybeSingle();
  return data?.is_active ? data : null;
}

// The buyer a "new match" email went to, from the private ?b=<token> on its
// booking link (migration 025). Only valid for that one listing.
// -> { user, identity, propertyId } or null.
async function buyerFromToken(listing, token) {
  if (!UUID_RE.test(String(token || ""))) return null;
  const { data: send, error } = await supabaseAdmin
    .from("listing_sends")
    .select("user_id")
    .eq("listing_id", listing.id)
    .eq("book_token", token)
    .maybeSingle();
  if (error || !send) return null;

  const [{ data: found }, { data: member }] = await Promise.all([
    supabaseAdmin.auth.admin.getUserById(send.user_id),
    supabaseAdmin.from("household_members").select("household_id").eq("user_id", send.user_id).maybeSingle(),
  ]);
  const user = found?.user;
  if (!user?.email) return null;

  // Their household's saved copy of this home (added when the listing was
  // sent), so the viewing lands in their ViewPal calendar.
  let propertyId = null;
  const key = listingKey(listing.listing_url);
  if (member && key) {
    const { data: saved } = await supabaseAdmin
      .from("properties")
      .select("id, listing_url")
      .eq("household_id", member.household_id)
      .ilike("listing_url", `%${key.split(":")[1]}%`);
    propertyId = (saved || []).find((p) => listingKey(p.listing_url) === key)?.id || null;
  }

  return { user, identity: await buyerIdentity(user), propertyId };
}

// No private link, but the email typed in belongs to a ViewPal buyer
// who has this home saved: link the booking to their account, so it goes in
// their calendar and moves the home along, as if they'd booked in the app.
// Only households that saved this exact home are checked, so a stranger
// can't put a viewing into the calendar of someone who never saved it.
async function buyerFromEmail(listing, email) {
  const key = listingKey(listing.listing_url);
  if (!key || !email) return null;
  const { data: saved } = await supabaseAdmin
    .from("properties")
    .select("id, household_id, listing_url")
    .ilike("listing_url", `%${key.split(":")[1]}%`);
  const copies = (saved || []).filter((p) => listingKey(p.listing_url) === key && p.household_id);
  if (!copies.length) return null;

  const { data: members } = await supabaseAdmin
    .from("household_members")
    .select("user_id, household_id")
    .in("household_id", [...new Set(copies.map((p) => p.household_id))]);
  for (const member of (members || []).slice(0, 20)) {
    const { data } = await supabaseAdmin.auth.admin.getUserById(member.user_id);
    if (data?.user?.email?.toLowerCase() === email.toLowerCase()) {
      const propertyId = copies.find((p) => p.household_id === member.household_id)?.id || null;
      return { user: data.user, identity: await buyerIdentity(data.user), propertyId };
    }
  }
  return null;
}

async function handleGetListing(req, res) {
  const listing = await loadListing(req.query.listing);
  if (!listing) return res.status(404).json({ error: "This booking link isn't active" });
  const buyer = req.query.b ? await buyerFromToken(listing, req.query.b) : null;

  // Sold or withdrawn: say so instead of offering times.
  if (listing.market_status === "sold_stc" || listing.market_status === "off_market") {
    return res.status(200).json({
      listing: {
        id: listing.id,
        address: listing.address,
        price: listing.price,
        notes: listing.notes,
        listingUrl: listing.listing_url,
        agent: listing.agents,
        closed: listing.market_status,
      },
      buyer: null,
      slots: [],
    });
  }

  const { data: slots } = await supabaseAdmin
    .from("viewing_slots")
    .select("id, starts_at, ends_at, capacity")
    .eq("listing_id", listing.id)
    .is("cancelled_at", null)
    .gt("starts_at", new Date().toISOString())
    .order("starts_at");

  const ids = (slots || []).map((s) => s.id);
  const { data: bookings } = ids.length
    ? await supabaseAdmin
        .from("viewing_bookings")
        .select("slot_id")
        .in("slot_id", ids)
        .eq("status", "confirmed")
    : { data: [] };

  const taken = {};
  for (const b of bookings || []) taken[b.slot_id] = (taken[b.slot_id] || 0) + 1;

  // Times the agent can no longer do: booked at another home, or too short
  // notice (migration 022).
  const { data: blocked } = ids.length
    ? await supabaseAdmin.rpc("listing_blocked_slots", { p_listing: listing.id })
    : { data: [] };
  const blockedIds = new Set(blocked || []);

  return res.status(200).json({
    listing: {
      id: listing.id,
      address: listing.address,
      price: listing.price,
      notes: listing.notes,
      listingUrl: listing.listing_url,
      agent: listing.agents,
    },
    // Filled in for the buyer the email went to, so they just pick a time.
    buyer: buyer
      ? { name: buyer.identity.name, email: buyer.user.email, phone: buyer.identity.phone }
      : null,
    slots: (slots || [])
      .map((s) => ({
        id: s.id,
        start: s.starts_at,
        end: s.ends_at,
        openHouse: s.capacity > 1,
        spacesLeft: s.capacity - (taken[s.id] || 0),
      }))
      .filter((s) => s.spacesLeft > 0 && !blockedIds.has(s.id)),
  });
}

async function loadByToken(token) {
  if (!UUID_RE.test(String(token || ""))) return null;
  const { data } = await supabaseAdmin
    .from("viewing_bookings")
    .select("*")
    .eq("cancel_token", token)
    .maybeSingle();
  return data;
}

async function handleGetBooking(req, res) {
  const booking = await loadByToken(req.query.cancel);
  const slot = booking ? await loadSlot(booking.slot_id) : null;
  if (!booking || !slot) return res.status(404).json({ error: "Booking not found" });

  return res.status(200).json({
    booking: {
      status: booking.status,
      name: booking.buyer_name,
      when: slotLabel(slot),
      address: slot.agent_listings.address,
      past: new Date(slot.starts_at) <= new Date(),
    },
  });
}

async function handleBook(req, res) {
  const body = req.body || {};

  // Honeypot: real users never see or fill this field.
  if (body.website) return res.status(200).json({ success: true });

  // From their "new match" email: we know who they are. Otherwise, if the
  // email typed in is a buyer who saved this home, link it to them.
  const knownListing = await loadListing(body.listingId);
  const typedEmail = clean(body.email, 254);
  const tokenBuyer = knownListing && body.b ? await buyerFromToken(knownListing, body.b) : null;
  const buyer =
    tokenBuyer ||
    (knownListing && typedEmail && EMAIL_RE.test(typedEmail) ? await buyerFromEmail(knownListing, typedEmail) : null);
  // Matched only by a typed email, anyone could be typing it (including the
  // agent): it goes in that buyer's calendar, but the booking isn't tied to
  // their account, so it never opens their buying position or proof
  // documents to the agent. The emailed link (b token) proves who it is.
  const bookingBuyerId = tokenBuyer ? tokenBuyer.user.id : null;

  const name = buyer ? clean(body.name, 100) || buyer.identity.name : clean(body.name, 100);
  // A known buyer always books under their account email.
  const email = buyer ? buyer.user.email : clean(body.email, 254);
  const phone = clean(body.phone, 40) || (buyer ? buyer.identity.phone : "");

  if (name === null || email === null || phone === null) {
    return res.status(400).json({ error: "Please check your details" });
  }
  if (!name) return res.status(400).json({ error: "Please add your name" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Please add a valid email address" });
  if (!phone) return res.status(400).json({ error: "Please add a phone number for the agent" });

  const listing = await loadListing(body.listingId);
  const slot = UUID_RE.test(String(body.slotId || "")) ? await loadSlot(body.slotId) : null;

  if (!listing || !slot || slot.listing_id !== listing.id) {
    return res.status(404).json({ error: "That viewing time isn't available" });
  }

  const since = new Date(Date.now() - 3600000).toISOString();
  const { data: listingSlots } = await supabaseAdmin
    .from("viewing_slots")
    .select("id")
    .eq("listing_id", listing.id);
  const { count: recent } = await supabaseAdmin
    .from("viewing_bookings")
    .select("id", { count: "exact", head: true })
    .in("slot_id", (listingSlots || []).map((s) => s.id))
    .gte("created_at", since);

  if ((recent ?? 0) >= MAX_BOOKINGS_PER_LISTING_PER_HOUR) {
    return res.status(429).json({ error: "Too many bookings right now. Please try again later." });
  }

  const { data: bookingId, error } = await supabaseAdmin.rpc("book_viewing", {
    p_slot: slot.id,
    p_buyer: bookingBuyerId,
    p_name: name,
    p_email: email.toLowerCase(),
    p_phone: phone,
    p_property: buyer?.propertyId ?? null,
  });

  if (error) {
    const known = Object.keys(BOOKING_ERRORS).find((code) => error.message?.includes(code));
    if (known) {
      const [status, message] = BOOKING_ERRORS[known];
      return res.status(status).json({ error: message });
    }
    console.error("book_viewing (guest) failed:", error);
    return res.status(500).json({ error: "Could not book that viewing. Please try again." });
  }

  const { data: booking } = await supabaseAdmin
    .from("viewing_bookings")
    .select("cancel_token")
    .eq("id", bookingId)
    .single();

  const base = appBaseUrl(req);
  const cancelUrl = `${base}/viewings/${listing.id}?cancel=${booking.cancel_token}`;
  const inCalendar = Boolean(buyer?.propertyId);
  if (inCalendar) await setCalendarViewing(buyer.propertyId, slot, slot.agents);

  await sendBookingEmails({
    slot,
    bookingId,
    buyer: { name, email, phone },
    base,
    inCalendar,
    cancelUrl,
  });

  return res.status(200).json({ success: true, cancelToken: booking.cancel_token });
}

async function handleCancel(req, res) {
  const booking = await loadByToken(req.body?.token);
  const slot = booking ? await loadSlot(booking.slot_id) : null;
  if (!booking || !slot) return res.status(404).json({ error: "Booking not found" });

  const { data: updated } = await supabaseAdmin
    .from("viewing_bookings")
    .update({ status: "cancelled", cancelled_by: "buyer", cancelled_at: new Date().toISOString() })
    .eq("id", booking.id)
    .eq("status", "confirmed")
    .select("id");

  if (!updated?.length) {
    return res.status(409).json({ error: "This viewing was already cancelled" });
  }

  const address = slot.agent_listings.address;
  const when = slotLabel(slot);
  // Booked from a match email: it was in their ViewPal calendar too.
  await clearCalendarViewing(booking.property_id, slot);
  // Both sides get the calendar update that removes it.
  const removal = cancelledIcs(slot, booking.id);

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
      ics: removal,
    }),
    sendEmail({
      to: booking.buyer_email,
      replyTo: slot.agents.email,
      subject: `Cancelled: ${address}, ${when}`,
      html: emailLayout(
        "Your viewing is cancelled",
        `<p style="margin:0;">Your viewing of <strong>${escapeHtml(address)}</strong> on
        ${escapeHtml(when)} is cancelled and the agent has been told. The attached update takes
        it out of your calendar.</p>`
      ),
      ics: removal,
    }),
  ]);

  return res.status(200).json({ success: true });
}

export default withCors(handler);

async function handler(req, res) {
  if (req.method === "GET") {
    if (req.query.cancel) return handleGetBooking(req, res);
    return handleGetListing(req, res);
  }

  if (req.method === "POST") {
    if (req.body?.action === "book") return handleBook(req, res);
    if (req.body?.action === "cancel") return handleCancel(req, res);
    return res.status(400).json({ error: "Unknown action" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
