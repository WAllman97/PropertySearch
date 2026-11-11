// Buyer accepts or declines a booking request.
//   POST /api/booking-respond { requestId, action: "accept" | "decline" }
//
// Accept: marks it accepted, adds the agent's property to the app (if a link
// was given), puts viewings into the app calendar (property_notes), and emails
// the agent and the buyer a calendar invite. The agent's email includes the
// buyer's phone number for calls; it is shared only at this point.
// Decline: frees the slot and emails the agent the booking link to pick again.
import { requireHouseholdUser, supabaseAdmin } from "./_lib/household.js";
import { appBaseUrl } from "./_lib/booking.js";
import { buildIcs, emailLayout, escapeHtml, sendEmail } from "./_lib/email.js";
import { formatLondon } from "./_lib/time.js";

function detectSource(url) {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (host.includes("rightmove")) return "rightmove";
  if (host.includes("zoopla")) return "zoopla";
  if (host.includes("onthemarket")) return "onthemarket";
  return "agent";
}

// Link the agent's property to an existing listing, or add it to the app.
async function linkProperty(request) {
  if (!request.property_url) return null;

  const { data: existing } = await supabaseAdmin
    .from("properties")
    .select("id")
    .eq("listing_url", request.property_url)
    .maybeSingle();

  if (existing) return existing.id;

  const address = request.property_address || `Sent by ${request.agency || request.agent_name}`;

  const { data: created, error } = await supabaseAdmin
    .from("properties")
    .insert({
      source: detectSource(request.property_url),
      listing_id: `agent_${request.id}`,
      title: address,
      address,
      listing_url: request.property_url,
      date_found: new Date().toISOString().slice(0, 10),
      status: "new",
    })
    .select("id")
    .single();

  if (error) {
    console.error("Could not add agent property:", error);
    return null;
  }

  return created.id;
}

function agentAcceptedEmail({ request, page, when }) {
  const isCall = request.kind === "call";
  const lines = [
    `<p style="margin:0 0 12px;">${escapeHtml(page.display_name)} has accepted your ${
      isCall ? "call" : "viewing"
    } request for <strong>${escapeHtml(when)}</strong>. A calendar invite is attached.</p>`,
  ];

  if (isCall && page.phone) {
    lines.push(
      `<p style="margin:0 0 12px;">Please call <strong>${escapeHtml(page.phone)}</strong> at that time.</p>`
    );
  }

  if (request.property_address) {
    lines.push(`<p style="margin:0 0 8px;">Property: ${escapeHtml(request.property_address)}</p>`);
  }

  return emailLayout(isCall ? "Call confirmed" : "Viewing confirmed", lines.join(""));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const user = await requireHouseholdUser(req, res);
    if (!user) return;

    const { requestId, action } = req.body || {};

    if (!requestId || !["accept", "decline"].includes(action)) {
      return res.status(400).json({ error: "Missing requestId or invalid action" });
    }

    const { data: request } = await supabaseAdmin
      .from("booking_requests")
      .select("*")
      .eq("id", requestId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!request) {
      return res.status(404).json({ error: "Request not found" });
    }

    if (request.status !== "pending") {
      return res.status(409).json({ error: `This request is already ${request.status}` });
    }

    const { data: page } = await supabaseAdmin
      .from("booking_pages")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    const start = new Date(request.starts_at);
    const end = new Date(request.ends_at);
    const when = formatLondon(start);
    const displayName = page?.display_name || user.email;

    if (action === "decline") {
      // Conditional update: only flips a request that is still pending.
      const { data: updated } = await supabaseAdmin
        .from("booking_requests")
        .update({ status: "declined", responded_at: new Date().toISOString() })
        .eq("id", request.id)
        .eq("status", "pending")
        .select("id");

      if (!updated?.length) {
        return res.status(409).json({ error: "This request was already answered" });
      }

      const rebook = page ? `${appBaseUrl(req)}/book/${page.slug}` : null;

      await sendEmail({
        to: request.agent_email,
        replyTo: user.email,
        subject: `${displayName} can't do ${when}`,
        html: emailLayout(
          "That time doesn't work",
          `<p style="margin:0 0 12px;">${escapeHtml(displayName)} can't make ${escapeHtml(when)}.</p>${
            rebook
              ? `<p style="margin:0;"><a href="${escapeHtml(rebook)}">Pick another time</a></p>`
              : ""
          }`
        ),
      });

      return res.status(200).json({ success: true, status: "declined" });
    }

    const propertyId = await linkProperty(request);

    const { data: updated } = await supabaseAdmin
      .from("booking_requests")
      .update({
        status: "accepted",
        responded_at: new Date().toISOString(),
        property_id: propertyId,
      })
      .eq("id", request.id)
      .eq("status", "pending")
      .select("id");

    if (!updated?.length) {
      return res.status(409).json({ error: "This request was already answered" });
    }

    // Viewings go straight into the existing viewing calendar, which also
    // drives the 24-hour reminder emails.
    if (request.kind === "viewing" && propertyId) {
      const { error: notesError } = await supabaseAdmin.from("property_notes").upsert(
        {
          property_id: propertyId,
          viewing_datetime: start.toISOString(),
          estate_agent: [request.agent_name, request.agency].filter(Boolean).join(", "),
          estate_agent_email: request.agent_email,
          estate_agent_phone: request.agent_phone,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "property_id" }
      );

      if (notesError) console.error("Could not add viewing to calendar:", notesError);
    }

    const isCall = request.kind === "call";
    const agentLabel = [request.agent_name, request.agency].filter(Boolean).join(", ");
    const ics = (summary, description) =>
      buildIcs({
        uid: request.id,
        start,
        end,
        summary,
        description,
        location: isCall ? null : request.property_address,
      });

    await sendEmail({
      to: request.agent_email,
      replyTo: user.email,
      subject: `Confirmed: ${isCall ? "call" : "viewing"} with ${displayName}, ${when}`,
      html: agentAcceptedEmail({ request, page: { ...page, display_name: displayName }, when }),
      ics: ics(
        isCall ? `Call ${displayName}` : `Viewing with ${displayName}`,
        [
          isCall && page?.phone ? `Phone: ${page.phone}` : "",
          request.property_address ? `Property: ${request.property_address}` : "",
          request.property_url || "",
        ].filter(Boolean).join("\n")
      ),
    });

    await sendEmail({
      to: user.email,
      subject: `Confirmed: ${isCall ? "call" : "viewing"} with ${agentLabel}, ${when}`,
      html: emailLayout(
        isCall ? "Call booked" : "Viewing booked",
        `<p style="margin:0 0 12px;">${escapeHtml(agentLabel)} ${
          isCall ? "will call you" : "will meet you"
        } on <strong>${escapeHtml(when)}</strong>. The invite is attached.</p>`
      ),
      ics: ics(
        isCall ? `Call from ${agentLabel}` : `Viewing: ${request.property_address || agentLabel}`,
        [
          request.agent_phone ? `Agent phone: ${request.agent_phone}` : "",
          `Agent email: ${request.agent_email}`,
          request.message ? `Message: ${request.message}` : "",
          request.property_url || "",
        ].filter(Boolean).join("\n")
      ),
    });

    return res.status(200).json({ success: true, status: "accepted", propertyId });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
}
