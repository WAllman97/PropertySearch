// Resend email + .ics calendar invites for the API routes.

const fromEmail = process.env.FROM_EMAIL || "PropertySearch <onboarding@resend.dev>";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function icsDate(date) {
  return date.toISOString().replace(/[-:]|\.\d{3}/g, "");
}

function icsText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

export function buildIcs({ uid, start, end, summary, description, location }) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PropertySearch//Bookings//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}@propertysearch`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(summary)}`,
    location ? `LOCATION:${icsText(location)}` : null,
    `DESCRIPTION:${icsText(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
}

// Plain, consistent wrapper so every booking email looks the same.
export function emailLayout(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:24px;background:#f8f6f2;font-family:Arial,sans-serif;color:#1f2937;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4ddd2;border-radius:14px;padding:24px;">
      <div style="font-size:11px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#b08d57;margin-bottom:8px;">PropertySearch</div>
      <h1 style="font-family:Georgia,serif;font-size:21px;color:#223a33;margin:0 0 16px;">${escapeHtml(title)}</h1>
      ${bodyHtml}
    </div>
  </body></html>`;
}

// Returns { sent: boolean }. With no RESEND_API_KEY (e.g. local dev) it logs
// and skips, so the booking flow still works end to end without sending mail.
export async function sendEmail({ to, subject, html, replyTo, ics }) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log(`[email skipped: no RESEND_API_KEY] to=${to} subject=${subject}`);
    return { sent: false };
  }

  const body = { from: fromEmail, to: [to], subject, html };

  if (replyTo) body.reply_to = replyTo;

  if (ics) {
    body.attachments = [
      { filename: "invite.ics", content: Buffer.from(ics).toString("base64") },
    ];
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error("Resend error:", await response.text());
    return { sent: false };
  }

  return { sent: true };
}
