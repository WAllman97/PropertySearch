import { requireHouseholdUser, supabaseAdmin, underRateLimit } from "./_lib/household.js";

const resendApiKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.FROM_EMAIL || "PropertySearch <onboarding@resend.dev>";

const MAX_MESSAGE_LENGTH = 1000;
const MAX_SHARES_PER_DAY = 20;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPrice(value) {
  if (value === null || value === undefined || value === "") {
    return "Price unavailable";
  }
  const number = Number(value);
  return Number.isFinite(number)
    ? `£${number.toLocaleString("en-GB")}`
    : "Price unavailable";
}

function buildShareHtml(property, message, senderEmail) {
  const address = escapeHtml(property.address || "Property");
  const price = formatPrice(property.price);
  const bedrooms = property.bedrooms ? `${escapeHtml(property.bedrooms)} bed` : "";
  const listingUrl = property.listing_url || "";
  const imageUrl = property.image_url || "";

  const messageBlock = message
    ? `<div style="background:#f9fafb;border-left:3px solid #dc2626;padding:12px 16px;
                   margin-bottom:20px;font-family:Arial,sans-serif;font-size:14px;
                   color:#374151;line-height:1.5;">${escapeHtml(message)}</div>`
    : "";

  const imageBlock = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" width="100%"
            style="max-width:560px;border-radius:10px;display:block;margin-bottom:16px;" />`
    : "";

  const bedroomsLine = bedrooms
    ? `<div style="font-family:Arial,sans-serif;font-size:13px;color:#6b7280;
                   margin-bottom:14px;">${bedrooms}</div>`
    : "";

  const listingButton = listingUrl
    ? `<a href="${escapeHtml(listingUrl)}"
          style="display:inline-block;background:#dc2626;color:#ffffff;padding:10px 20px;
                 border-radius:7px;text-decoration:none;font-family:Arial,sans-serif;
                 font-size:13px;font-weight:bold;">View listing &rarr;</a>`
    : "";

  return `
  <!DOCTYPE html>
  <html lang="en"><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:0;background:#f1f5f9;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
        <tr><td style="background:#111827;border-radius:14px 14px 0 0;padding:22px 28px;">
          <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;
                      text-transform:uppercase;letter-spacing:1.5px;color:#9ca3af;
                      margin-bottom:6px;">Shared with you${
                        senderEmail ? ` by ${escapeHtml(senderEmail)}` : ""
                      }</div>
          <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;
                      color:#ffffff;">Take a look at this property</div>
        </td></tr>
        <tr><td style="background:#ffffff;border-radius:0 0 14px 14px;padding:24px 28px;">
          ${messageBlock}
          ${imageBlock}
          <div style="font-family:Georgia,serif;font-size:24px;font-weight:bold;
                      color:#111827;margin-bottom:5px;">${price}</div>
          <div style="font-family:Arial,sans-serif;font-size:14px;color:#4b5563;
                      margin-bottom:6px;">${address}</div>
          ${bedroomsLine}
          ${listingButton}
        </td></tr>
        <tr><td style="font-family:Arial,sans-serif;font-size:11px;color:#9ca3af;
                       text-align:center;padding:16px 0;">
          Shared from PropertySearch.
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { propertyId, toEmail, message } = req.body || {};

    if (!propertyId) {
      return res.status(400).json({ error: "Missing propertyId" });
    }

    if (
      typeof toEmail !== "string" ||
      toEmail.length > 254 ||
      !EMAIL_RE.test(toEmail)
    ) {
      return res.status(400).json({ error: "Please provide a valid recipient email" });
    }

    if (message && (typeof message !== "string" || message.length > MAX_MESSAGE_LENGTH)) {
      return res.status(400).json({
        error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer`,
      });
    }

    const user = await requireHouseholdUser(req, res);
    if (!user) return;

    if (!resendApiKey) {
      return res.status(500).json({
        error: "Email is not configured (missing RESEND_API_KEY on the server)",
      });
    }

    const { data: property, error: propertyError } = await supabaseAdmin
      .from("properties")
      .select("*")
      .eq("id", propertyId)
      .single();

    if (propertyError || !property) {
      return res.status(404).json({ error: "Property not found" });
    }

    if (!(await underRateLimit(user.id, "share_property", MAX_SHARES_PER_DAY, 24 * 60))) {
      return res.status(429).json({
        error: `Share limit reached (${MAX_SHARES_PER_DAY} per day). Try again tomorrow.`,
      });
    }

    const html = buildShareHtml(property, message, user.email);
    const subject = `${user.email || "Someone"} shared a property: ${
      property.address || "Property"
    }`;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        reply_to: user.email || undefined,
        subject,
        html,
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      console.error("Resend error:", details);
      // Log the provider's details server-side only; they can include
      // account/domain configuration we don't want to hand to the browser.
      return res.status(502).json({
        error: "The email provider rejected the message",
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
}
