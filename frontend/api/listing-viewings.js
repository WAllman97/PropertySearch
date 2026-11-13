// Public booking for an agent's share link: /viewings/<listing id>. No login.
//   GET  ?listing=<id>                 listing, agent and open times
//   GET  ?cancel=<token>               a guest booking, for the cancel page
//   POST { action: "book", listingId, slotId, name, email, phone }
//   POST { action: "cancel", token }   guest cancels with the link in their email
//
// Only what an agent already advertises is exposed (address, price, their
// name and phone, open times and spaces left). Other buyers' details are
// never returned. Migration 007.
import { supabaseAdmin } from "./_lib/household.js";
import { appBaseUrl } from "./_lib/booking.js";
import { emailLayout, escapeHtml, sendEmail } from "./_lib/email.js";
import { BOOKING_ERRORS, loadSlot, sendBookingEmails, slotLabel } from "./_lib/viewings.js";

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
    .select("id, address, price, notes, listing_url, is_active, agents(name, agency, branch, phone)")
    .eq("id", listingId)
    .maybeSingle();
  return data?.is_active ? data : null;
}

async function handleGetListing(req, res) {
  const listing = await loadListing(req.query.listing);
  if (!listing) return res.status(404).json({ error: "This booking link isn't active" });

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

  return res.status(200).json({
    listing: {
      id: listing.id,
      address: listing.address,
      price: listing.price,
      notes: listing.notes,
      listingUrl: listing.listing_url,
      agent: listing.agents,
    },
    slots: (slots || [])
      .map((s) => ({
        id: s.id,
        start: s.starts_at,
        end: s.ends_at,
        openHouse: s.capacity > 1,
        spacesLeft: s.capacity - (taken[s.id] || 0),
      }))
      .filter((s) => s.spacesLeft > 0),
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

  const name = clean(body.name, 100);
  const email = clean(body.email, 254);
  const phone = clean(body.phone, 40);

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
    p_buyer: null,
    p_name: name,
    p_email: email.toLowerCase(),
    p_phone: phone,
    p_property: null,
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

  await sendBookingEmails({
    slot,
    bookingId,
    buyer: { name, email, phone },
    base,
    inCalendar: false,
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

  await sendEmail({
    to: slot.agents.email,
    replyTo: booking.buyer_email,
    subject: `Viewing cancelled: ${address}, ${when}`,
    html: emailLayout(
      "Viewing cancelled by the buyer",
      `<p style="margin:0;">${escapeHtml(booking.buyer_name)} has cancelled their viewing of
      <strong>${escapeHtml(address)}</strong> on ${escapeHtml(when)}. The space is free again.</p>`
    ),
  });

  return res.status(200).json({ success: true });
}

export default async function handler(req, res) {
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
