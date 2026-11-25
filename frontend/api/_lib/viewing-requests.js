// Viewing requests to agents who aren't on PropertySearch (migration 023),
// handled by /api/viewings:
//   buyer (signed in, household):
//     { action: "request", propertyId, agentEmail, agentName?, options: [iso, ...],
//       durationMinutes?, message?, phone? }
//     { action: "cancel_request", requestId }
//     { action: "accept_proposal", requestId }
//   agent (no account, private token from the email):
//     { action: "request_details", token }
//     { action: "respond_request", token, choice: "confirm" | "propose" | "decline",
//       option?, proposedStart?, note? }
//     { action: "request_opt_out", token }
//   buyer (private token from the "agent suggests a time" email, migration 027):
//     { action: "proposal_details", token }
//     { action: "proposal_answer", token, accept }
//
// Links in the email only open /request/<token>; nothing changes until the
// agent presses a button there (mail scanners open links automatically).
import { householdMemberIds, requireHouseholdUser, supabaseAdmin, underRateLimit } from "./household.js";
import { appBaseUrl } from "./booking.js";
import { buildIcs, emailLayout, escapeHtml, sendEmail } from "./email.js";
import { formatLondon } from "./time.js";
import { detailRow } from "./viewings.js";
import { sendToUsers } from "./push.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DURATIONS = [15, 20, 30, 45, 60];
const MAX_REQUESTS_PER_DAY = 10; // per buyer
const MAX_PER_AGENT_PER_DAY = 15; // per agent email, across all buyers
const HOUR = 3600000;

const clean = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const when = (iso) => formatLondon(new Date(iso));
const button = (href, label, primary = true) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border-radius:10px;font-weight:bold;font-size:14px;text-decoration:none;${
    primary ? "background:#223a33;color:#ffffff;" : "background:#ffffff;color:#223a33;border:1px solid #223a33;"
  }">${escapeHtml(label)}</a>`;

// "Ready to proceed · budget £950k · AIP £760k (Nationwide) · first-time buyer ..."
const SELLING = {
  first_time: "first-time buyer",
  nothing_to_sell: "nothing to sell",
  sold_stc: "own home sold STC",
  on_market: "own home on the market",
  not_listed: "needs to sell, not listed yet",
};
const MOVE = { asap: "moving ASAP", "3_months": "within 3 months", "6_months": "within 6 months", flexible: "flexible on timing" };
const pounds = (n) => (n >= 1e6 ? `£${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")}m` : `£${Math.round(n / 1000)}k`);

export function positionText(p) {
  if (!p || !p.share_with_agents) return "";
  const parts = [];
  if (p.max_budget) parts.push(`budget ${pounds(p.max_budget)}`);
  if (p.buying_with === "cash") parts.push("cash buyer");
  else if (p.mortgage_status === "offer") parts.push(`mortgage offer${p.aip_amount ? ` ${pounds(p.aip_amount)}` : ""}`);
  else if (p.mortgage_status === "aip")
    parts.push(`mortgage in principle${p.aip_amount ? ` ${pounds(p.aip_amount)}` : ""}${p.aip_lender ? ` (${p.aip_lender})` : ""}`);
  if (SELLING[p.selling_status]) parts.push(SELLING[p.selling_status]);
  if (p.solicitor_ready) parts.push("solicitor ready");
  if (MOVE[p.move_timeframe]) parts.push(MOVE[p.move_timeframe]);
  return parts.join(" · ");
}

async function memberContacts(householdId) {
  const ids = await householdMemberIds(householdId);
  const users = await Promise.all(ids.map((id) => supabaseAdmin.auth.admin.getUserById(id)));
  return { ids, emails: users.map((u) => u.data?.user?.email).filter(Boolean) };
}

async function loadByToken(token) {
  if (!UUID_RE.test(String(token || ""))) return null;
  const { data } = await supabaseAdmin
    .from("viewing_requests")
    .select("*, properties(id, address, listing_url, image_url, price, bedrooms)")
    .eq("token", token)
    .maybeSingle();
  return data;
}

async function loadOwn(user, requestId) {
  if (!UUID_RE.test(String(requestId || ""))) return null;
  const { data } = await supabaseAdmin
    .from("viewing_requests")
    .select("*, properties(id, address, listing_url)")
    .eq("id", requestId)
    .eq("household_id", user.householdId)
    .maybeSingle();
  return data;
}

// cancelled: the removal for the invite sent at confirm time (same UID), so
// the viewing comes out of the agent's and the household's calendars.
function ics(request, start, forAgent, cancelled = false) {
  const address = request.properties.address;
  return buildIcs({
    uid: `request-${request.id}`,
    start: new Date(start),
    end: new Date(new Date(start).getTime() + request.duration_minutes * 60000),
    summary: cancelled
      ? `Cancelled: viewing at ${address}`
      : forAgent ? `Viewing: ${address} (${request.buyer_name})` : `Viewing: ${address}`,
    description: cancelled
      ? "This viewing has been cancelled."
      : forAgent
        ? [`Buyer: ${request.buyer_name}`, request.buyer_phone ? `Phone: ${request.buyer_phone}` : "", `Email: ${request.buyer_email}`]
            .filter(Boolean)
            .join("\n")
        : [`Agent: ${request.agent_name || request.agent_email}`, `Email: ${request.agent_email}`].join("\n"),
    location: address,
    cancelled,
  });
}

// Confirmed: into the household calendar, and both sides get an invite.
async function confirm(request, start, req) {
  const now = new Date().toISOString();
  const { data: updated, error } = await supabaseAdmin
    .from("viewing_requests")
    .update({ status: "confirmed", confirmed_start: start, proposed_start: null, responded_at: now, updated_at: now })
    .eq("id", request.id)
    .in("status", ["pending", "proposed"])
    .select("id")
    .maybeSingle();
  if (error || !updated) return false;

  await supabaseAdmin.from("property_notes").upsert(
    {
      property_id: request.property_id,
      viewing_datetime: start,
      estate_agent: request.agent_name || request.agent_email,
      estate_agent_email: request.agent_email,
      reminder_sent_at: null,
      updated_at: now,
    },
    { onConflict: "property_id" }
  );
  await supabaseAdmin
    .from("properties")
    .update({ status: "viewing_booked" })
    .eq("id", request.property_id)
    .in("status", ["new", "favourite"]);

  const address = request.properties.address;
  const label = when(start);
  const { ids, emails } = await memberContacts(request.household_id);
  const base = appBaseUrl(req);
  await Promise.all([
    sendEmail({
      to: request.agent_email,
      replyTo: request.buyer_email,
      subject: `Viewing confirmed: ${address}, ${label}`,
      html: emailLayout(
        "Viewing confirmed",
        `<p style="margin:0 0 12px;">Thanks. ${escapeHtml(request.buyer_name)} has the viewing in their calendar and gets a reminder the day before.</p>
        <table style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">
          ${detailRow("Property", escapeHtml(address))}
          ${detailRow("When", escapeHtml(label))}
          ${detailRow("Buyer", escapeHtml(request.buyer_name))}
          ${detailRow("Phone", escapeHtml(request.buyer_phone))}
          ${detailRow("Email", escapeHtml(request.buyer_email))}
        </table>
        <p style="margin:0;font-size:13px;color:#6b7280;">Need to change it? Reply to this email to reach ${escapeHtml(request.buyer_name)}.</p>`
      ),
      ics: ics(request, start, true),
    }),
    ...emails.map((to) =>
      sendEmail({
        to,
        replyTo: request.agent_email,
        subject: `Viewing confirmed: ${address}, ${label}`,
        html: emailLayout(
          "Your viewing is confirmed",
          `<table style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">
            ${detailRow("Property", escapeHtml(address))}
            ${detailRow("When", escapeHtml(label))}
            ${detailRow("Agent", escapeHtml(request.agent_name || request.agent_email || "The agent"))}
            ${detailRow("Agent's note", escapeHtml(request.agent_note))}
          </table>
          <p style="margin:0;">It's in your PropertySearch calendar. Reply to this email to reach the agent.</p>`
        ),
        ics: ics(request, start, false),
      })
    ),
    sendToUsers(ids, {
      title: "Viewing confirmed",
      body: `${address}, ${label}`,
      url: "/?view=calendar",
    }),
  ]);
  return true;
}

// ---------------------------------------------------------------------------
// Buyer

export async function handleRequest(req, res) {
  const user = await requireHouseholdUser(req, res);
  if (!user) return;
  const body = req.body || {};

  const agentEmail = clean(body.agentEmail, 254).toLowerCase();
  const agentName = clean(body.agentName, 100);
  const message = clean(body.message, 500);
  const phone = clean(body.phone, 40);
  const duration = DURATIONS.includes(Number(body.durationMinutes)) ? Number(body.durationMinutes) : 30;
  // The agent's email is optional (migration 028): portals hide it behind a
  // contact form, so without it the buyer sends the agent the link instead.
  if (agentEmail && !EMAIL_RE.test(agentEmail)) {
    return res.status(400).json({ error: "That agent email doesn't look right. Leave it blank to send the request yourself." });
  }
  if (agentEmail.endsWith("@viewpal.co.uk")) return res.status(400).json({ error: "That's one of our addresses, not the agent's" });

  const now = Date.now();
  const raw = Array.isArray(body.options) ? body.options.slice(0, 3) : [];
  const options = [...new Set(raw.map((o) => new Date(o)).filter((d) => !Number.isNaN(d.getTime())).map((d) => d.toISOString()))].sort();
  if (!options.length) return res.status(400).json({ error: "Pick at least one time" });
  if (options.some((o) => new Date(o).getTime() < now + 2 * HOUR)) {
    return res.status(400).json({ error: "Pick times at least two hours from now" });
  }
  if (options.some((o) => new Date(o).getTime() > now + 60 * 24 * HOUR)) {
    return res.status(400).json({ error: "Pick times within the next two months" });
  }

  const { data: property } = await supabaseAdmin
    .from("properties")
    .select("id, address, listing_url, image_url, price, bedrooms")
    .eq("id", String(body.propertyId || ""))
    .eq("household_id", user.householdId)
    .maybeSingle();
  if (!property) return res.status(404).json({ error: "Home not found" });

  const { data: optedOut } = agentEmail
    ? await supabaseAdmin.from("viewing_request_opt_outs").select("email").eq("email", agentEmail).maybeSingle()
    : { data: null };
  if (optedOut) {
    return res.status(409).json({ error: "This agent has asked not to get requests through PropertySearch. Please contact them directly." });
  }
  if (!(await underRateLimit(user.id, "viewing_request", MAX_REQUESTS_PER_DAY, 24 * 60))) {
    return res.status(429).json({ error: "That's a lot of requests today. Please try again tomorrow." });
  }
  const { count: toAgent } = agentEmail
    ? await supabaseAdmin
        .from("viewing_requests")
        .select("id", { count: "exact", head: true })
        .eq("agent_email", agentEmail)
        .gte("created_at", new Date(now - 24 * HOUR).toISOString())
    : { count: 0 };
  if ((toAgent || 0) >= MAX_PER_AGENT_PER_DAY) {
    return res.status(429).json({ error: "This agent has had a lot of requests today. Please try again tomorrow." });
  }

  const meta = user.user_metadata || {};
  const buyerName = clean(meta.name || meta.full_name, 100) || user.email.split("@")[0];
  const { data: request, error } = await supabaseAdmin
    .from("viewing_requests")
    .insert({
      household_id: user.householdId,
      property_id: property.id,
      requested_by: user.id,
      buyer_name: buyerName,
      buyer_email: user.email,
      buyer_phone: phone || null,
      agent_email: agentEmail || null,
      agent_name: agentName || null,
      message: message || null,
      options,
      duration_minutes: duration,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "There's already an open request for this home" });
    console.error("viewing request insert failed:", error);
    return res.status(500).json({ error: "Could not send the request. Please try again." });
  }

  // Keep the agent's details with the home, as if typed into its notes.
  const { data: notes } = await supabaseAdmin
    .from("property_notes").select("estate_agent, estate_agent_email").eq("property_id", property.id).maybeSingle();
  if (agentEmail && !notes?.estate_agent_email) {
    await supabaseAdmin.from("property_notes").upsert(
      {
        property_id: property.id,
        estate_agent: notes?.estate_agent || agentName || null,
        estate_agent_email: agentEmail,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "property_id" }
    );
  }

  const { data: position } = await supabaseAdmin
    .from("buyer_positions").select("*").eq("household_id", user.householdId).maybeSingle();
  const positionLine = positionText(position);
  const page = `${appBaseUrl(req)}/request/${request.token}`;

  // No email for the agent: hand the buyer a ready message with the agent's
  // private link, to paste into the portal's contact form, WhatsApp or a text.
  if (!agentEmail) {
    const shareText = [
      `Hi${agentName ? ` ${agentName.split(/\s+/)[0]}` : ""}, I'd like to view ${property.address}.`,
      `Times that suit me: ${options.map(when).join(", ")}.`,
      positionLine ? `My position: ${positionLine}.` : "",
      `You can confirm one (or suggest another) in one tap here, no account needed: ${page}`,
      `Thanks, ${buyerName}${phone ? `, ${phone}` : ""}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return res.status(200).json({ success: true, requestId: request.id, emailed: false, shareUrl: page, shareText });
  }

  const sent = await sendEmail({
    to: agentEmail,
    replyTo: user.email,
    subject: `Viewing request: ${property.address}`,
    html: emailLayout(
      "Viewing request",
      `<p style="margin:0 0 12px;">${agentName ? `Hi ${escapeHtml(agentName.split(/\s+/)[0])}, ` : ""}${escapeHtml(buyerName)} would like to view
      <a href="${escapeHtml(property.listing_url)}" style="color:#223a33;font-weight:bold;">${escapeHtml(property.address)}</a>.</p>
      ${positionLine ? `<p style="margin:0 0 12px;padding:8px 12px;background:#f3f7f5;border-radius:8px;font-size:14px;">Buyer's position: ${escapeHtml(positionLine)}</p>` : ""}
      ${message ? `<p style="margin:0 0 12px;font-style:italic;">“${escapeHtml(message)}”</p>` : ""}
      <p style="margin:0 0 8px;">Times that suit them (${duration} minutes):</p>
      <p style="margin:0 0 8px;">${options.map((o, i) => button(`${page}?pick=${i}`, when(o))).join("")}</p>
      <p style="margin:0 0 16px;">${button(page, "Suggest another time", false)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Tap a time to confirm it on the next page. Once confirmed, you both get a calendar invite.
      Or reply to this email to reach ${escapeHtml(buyerName)} directly.</p>
      <hr style="border:0;border-top:1px solid #e4ddd2;margin:16px 0;">
      <p style="margin:0;font-size:12px;color:#9a9186;">Sent by PropertySearch for a buyer viewing homes you're marketing. Agents on PropertySearch publish their viewing times once and buyers book themselves:
      <a href="${escapeHtml(appBaseUrl(req))}/agents" style="color:#9a9186;">see how it works</a>.
      Don't want these? <a href="${escapeHtml(page)}?stop=1" style="color:#9a9186;">Stop requests to this address</a>.</p>`
    ),
  });

  return res.status(200).json({ success: true, requestId: request.id, emailed: sent?.sent !== false });
}

export async function handleCancelRequest(req, res) {
  const user = await requireHouseholdUser(req, res);
  if (!user) return;
  const request = await loadOwn(user, req.body?.requestId);
  if (!request) return res.status(404).json({ error: "Request not found" });
  if (["cancelled", "declined"].includes(request.status)) return res.status(200).json({ success: true });

  const now = new Date().toISOString();
  // Only from the status we read: if the agent confirmed in the meantime, a
  // cancel based on "pending" would skip the calendar removals below.
  const { data: updated } = await supabaseAdmin
    .from("viewing_requests")
    .update({ status: "cancelled", updated_at: now })
    .eq("id", request.id)
    .eq("status", request.status)
    .select("id")
    .maybeSingle();
  if (!updated) return res.status(409).json({ error: "This request has just changed. Refresh and try again." });

  // Property status is left as it is: no other cancel path moves a home back
  // from "Viewing booked", and the buyer may have moved it on by hand.
  const wasConfirmed = request.status === "confirmed";
  if (wasConfirmed) {
    await supabaseAdmin
      .from("property_notes")
      .update({ viewing_datetime: null, updated_at: now })
      .eq("property_id", request.property_id)
      .eq("viewing_datetime", request.confirmed_start);
  }

  const address = request.properties.address;
  // Everyone who got the invite at confirm time gets the matching removal.
  const { emails } = wasConfirmed ? await memberContacts(request.household_id) : { emails: [] };
  await Promise.all([
    sendEmail({
      to: request.agent_email,
      replyTo: request.buyer_email,
      subject: wasConfirmed
        ? `Viewing cancelled: ${address}, ${when(request.confirmed_start)}`
        : `Viewing request withdrawn: ${address}`,
      html: emailLayout(
        wasConfirmed ? "Viewing cancelled" : "Request withdrawn",
        `<p style="margin:0;">${escapeHtml(request.buyer_name)} has ${
          wasConfirmed ? `cancelled the viewing of <strong>${escapeHtml(address)}</strong> on ${escapeHtml(when(request.confirmed_start))}` : `withdrawn their request to view <strong>${escapeHtml(address)}</strong>`
        }. No need to do anything${wasConfirmed ? ": the attached update takes it out of your calendar" : ""}. Reply to this email to reach them.</p>`
      ),
      ics: wasConfirmed ? ics(request, request.confirmed_start, true, true) : undefined,
    }),
    ...emails.map((to) =>
      sendEmail({
        to,
        replyTo: request.agent_email,
        subject: `Cancelled: ${address}, ${when(request.confirmed_start)}`,
        html: emailLayout(
          "Your viewing is cancelled",
          `<p style="margin:0;">The viewing of <strong>${escapeHtml(address)}</strong> on
          ${escapeHtml(when(request.confirmed_start))} is cancelled and the agent has been told. The attached
          update takes it out of your calendar.</p>`
        ),
        ics: ics(request, request.confirmed_start, false, true),
      })
    ),
  ]);
  return res.status(200).json({ success: true });
}

export async function handleAcceptProposal(req, res) {
  const user = await requireHouseholdUser(req, res);
  if (!user) return;
  const request = await loadOwn(user, req.body?.requestId);
  if (!request || request.status !== "proposed") return res.status(404).json({ error: "Nothing to accept" });
  if (new Date(request.proposed_start).getTime() < Date.now()) {
    return res.status(410).json({ error: "That time has passed. Send a new request." });
  }
  const ok = await confirm(request, request.proposed_start, req);
  return ok ? res.status(200).json({ success: true }) : res.status(409).json({ error: "This request has changed. Refresh and try again." });
}

// ---------------------------------------------------------------------------
// Agent (token)

export async function handleRequestDetails(req, res) {
  const request = await loadByToken(req.body?.token);
  if (!request) return res.status(404).json({ error: "This request link isn't valid" });
  const { data: position } = await supabaseAdmin
    .from("buyer_positions").select("*").eq("household_id", request.household_id).maybeSingle();
  const { data: optedOut } = await supabaseAdmin
    .from("viewing_request_opt_outs").select("email").eq("email", (request.agent_email || "").toLowerCase()).maybeSingle();
  const p = request.properties;
  return res.status(200).json({
    request: {
      status: request.status,
      buyerName: request.buyer_name,
      buyerEmail: request.buyer_email,
      buyerPhone: request.buyer_phone,
      position: positionText(position),
      message: request.message,
      options: request.options,
      durationMinutes: request.duration_minutes,
      confirmedStart: request.confirmed_start,
      proposedStart: request.proposed_start,
      agentNote: request.agent_note,
      optedOut: Boolean(optedOut),
      property: { address: p.address, listingUrl: p.listing_url, imageUrl: p.image_url, price: p.price, bedrooms: p.bedrooms },
    },
  });
}

export async function handleRespondRequest(req, res) {
  const body = req.body || {};
  const request = await loadByToken(body.token);
  if (!request) return res.status(404).json({ error: "This request link isn't valid" });
  if (!["pending", "proposed"].includes(request.status)) {
    return res.status(409).json({ error: `This request is already ${request.status}.` });
  }
  const note = clean(body.note, 500) || null;
  const now = new Date();
  const address = request.properties.address;
  const base = appBaseUrl(req);
  const { ids, emails } = await memberContacts(request.household_id);

  if (body.choice === "confirm") {
    const start = request.options[Number(body.option)];
    if (!start) return res.status(400).json({ error: "Pick one of the times" });
    if (new Date(start).getTime() < now.getTime()) return res.status(410).json({ error: "That time has passed. Suggest another instead." });
    if (note) await supabaseAdmin.from("viewing_requests").update({ agent_note: note }).eq("id", request.id);
    const ok = await confirm({ ...request, agent_note: note }, start, req);
    return ok ? res.status(200).json({ success: true, status: "confirmed" }) : res.status(409).json({ error: "This request has just changed. Refresh the page." });
  }

  if (body.choice === "propose") {
    const start = new Date(body.proposedStart);
    if (Number.isNaN(start.getTime()) || start.getTime() < now.getTime() + HOUR) {
      return res.status(400).json({ error: "Pick a time at least an hour from now" });
    }
    if (start.getTime() > now.getTime() + 90 * 24 * HOUR) return res.status(400).json({ error: "Pick a time within three months" });
    const { data: updated } = await supabaseAdmin
      .from("viewing_requests")
      .update({ status: "proposed", proposed_start: start.toISOString(), agent_note: note, responded_at: now.toISOString(), updated_at: now.toISOString() })
      .eq("id", request.id)
      .in("status", ["pending", "proposed"])
      .select("id")
      .maybeSingle();
    if (!updated) return res.status(409).json({ error: "This request has just changed. Refresh the page." });
    const label = when(start.toISOString());
    await Promise.all([
      ...emails.map((to) =>
        sendEmail({
          to,
          replyTo: request.agent_email,
          subject: `The agent suggests ${label}: ${address}`,
          html: emailLayout(
            "The agent suggested another time",
            `<p style="margin:0 0 12px;">${escapeHtml(request.agent_name || request.agent_email || "The agent")} can't do your times for
            <strong>${escapeHtml(address)}</strong>, but suggests <strong>${escapeHtml(label)}</strong>.</p>
            ${note ? `<p style="margin:0 0 12px;font-style:italic;">“${escapeHtml(note)}”</p>` : ""}
            <p style="margin:0 0 16px;">${button(
              request.buyer_token ? `${base}/suggested/${request.buyer_token}` : `${base}/?view=history`,
              "Accept or decline"
            )}</p>
            <p style="margin:0;color:#6b7280;font-size:13px;">One tap, no login needed.</p>`
          ),
        })
      ),
      sendToUsers(ids, { title: "The agent suggested a time", body: `${address}: ${label}`, url: "/?view=history" }),
    ]);
    return res.status(200).json({ success: true, status: "proposed" });
  }

  if (body.choice === "decline") {
    const { data: updated } = await supabaseAdmin
      .from("viewing_requests")
      .update({ status: "declined", agent_note: note, responded_at: now.toISOString(), updated_at: now.toISOString() })
      .eq("id", request.id)
      .in("status", ["pending", "proposed"])
      .select("id")
      .maybeSingle();
    if (!updated) return res.status(409).json({ error: "This request has just changed. Refresh the page." });
    await Promise.all(
      emails.map((to) =>
        sendEmail({
          to,
          replyTo: request.agent_email,
          subject: `Viewing request declined: ${address}`,
          html: emailLayout(
            "The agent can't do a viewing",
            `<p style="margin:0 0 12px;">${escapeHtml(request.agent_name || request.agent_email || "The agent")} can't arrange a viewing of
            <strong>${escapeHtml(address)}</strong> at the moment.</p>
            ${note ? `<p style="margin:0 0 12px;font-style:italic;">“${escapeHtml(note)}”</p>` : ""}
            <p style="margin:0;">Reply to this email to ask them about it.</p>`
          ),
        })
      )
    );
    return res.status(200).json({ success: true, status: "declined" });
  }

  return res.status(400).json({ error: "Unknown choice" });
}

export async function handleRequestOptOut(req, res) {
  const request = await loadByToken(req.body?.token);
  if (!request) return res.status(404).json({ error: "This request link isn't valid" });
  // Sent by the buyer themselves (no agent email): nothing to block.
  if (!request.agent_email) return res.status(200).json({ success: true });
  await supabaseAdmin
    .from("viewing_request_opt_outs")
    .upsert({ email: request.agent_email.toLowerCase() }, { onConflict: "email" });
  return res.status(200).json({ success: true });
}

// ---------------------------------------------------------------------------
// Buyer (token): answer the agent's suggested time from the email, no login.

async function loadByBuyerToken(token) {
  if (!UUID_RE.test(String(token || ""))) return null;
  const { data } = await supabaseAdmin
    .from("viewing_requests")
    .select("*, properties(id, address, listing_url, image_url, price, bedrooms)")
    .eq("buyer_token", token)
    .maybeSingle();
  return data;
}

export async function handleProposalDetails(req, res) {
  const request = await loadByBuyerToken(req.body?.token);
  if (!request) return res.status(404).json({ error: "This link isn't valid any more" });
  const p = request.properties;
  return res.status(200).json({
    request: {
      status: request.status,
      agentName: request.agent_name || request.agent_email || "The agent",
      agentNote: request.agent_note,
      proposedStart: request.proposed_start,
      confirmedStart: request.confirmed_start,
      property: { address: p.address, imageUrl: p.image_url, price: p.price, bedrooms: p.bedrooms },
    },
  });
}

export async function handleProposalAnswer(req, res) {
  const request = await loadByBuyerToken(req.body?.token);
  if (!request) return res.status(404).json({ error: "This link isn't valid any more" });
  if (typeof req.body.accept !== "boolean") return res.status(400).json({ error: "Missing answer" });
  if (request.status !== "proposed") {
    return res.status(409).json({ error: "This has already been answered.", status: request.status });
  }

  if (req.body.accept) {
    if (new Date(request.proposed_start).getTime() < Date.now()) {
      return res.status(410).json({ error: "That time has passed. Ask the agent for another." });
    }
    const ok = await confirm(request, request.proposed_start, req);
    return ok
      ? res.status(200).json({ success: true, status: "confirmed" })
      : res.status(409).json({ error: "This has just changed. Refresh the page." });
  }

  // Can't make it: close the request and let the agent know.
  const now = new Date().toISOString();
  // A stale page must not cancel a newer suggestion: also check the time
  // being declined is still the one on the request.
  const { data: updated } = await supabaseAdmin
    .from("viewing_requests")
    .update({ status: "cancelled", updated_at: now })
    .eq("id", request.id)
    .eq("status", "proposed")
    .eq("proposed_start", request.proposed_start)
    .select("id")
    .maybeSingle();
  if (!updated) {
    return res.status(409).json({ error: "This has just changed. Refresh the page to see the latest." });
  }
  await sendEmail({
    to: request.agent_email,
    replyTo: request.buyer_email,
    subject: `Can't make that time: ${request.properties.address}`,
    html: emailLayout(
      "The buyer can't make your suggested time",
      `<p style="margin:0;">${escapeHtml(request.buyer_name)} can't make ${escapeHtml(when(request.proposed_start))}
      for <strong>${escapeHtml(request.properties.address)}</strong>. Reply to this email to find another time.</p>`
    ),
  });
  return res.status(200).json({ success: true, status: "cancelled" });
}
