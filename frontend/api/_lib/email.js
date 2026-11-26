// Resend email + .ics calendar invites for the API routes.

const fromEmail = process.env.FROM_EMAIL || "ViewPal <onboarding@resend.dev>";

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

// The bare address out of "ViewPal <bookings@example.com>", for the
// invite's ORGANIZER line.
function addressOf(value) {
  const match = String(value || "").match(/<([^>]+)>/);
  return (match ? match[1] : String(value || "")).trim();
}

function displayNameOf(value) {
  const match = String(value || "").match(/^\s*"?([^"<]*?)"?\s*</);
  return match ? match[1].trim() : "";
}

// RFC 5545 caps lines at 75 octets: longer ones are split with CRLF + one
// space. Counted in bytes, and never through the middle of a UTF-8 character
// (addresses with "é" or "£" in a note would otherwise corrupt).
function foldLine(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts = [];
  let current = "";
  let size = 0;
  let limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (size + n > limit) {
      parts.push(current);
      current = "";
      size = 0;
      limit = 74; // the leading space counts towards the 75
    }
    current += ch;
    size += n;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function attendeeLine(email) {
  return `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:${addressOf(email)}`;
}

function organizerLine() {
  const name = displayNameOf(fromEmail).replace(/[";:,]/g, "");
  return `ORGANIZER${name ? `;CN="${name}"` : ""}:mailto:${addressOf(fromEmail)}`;
}

// cancelled: the same event (same UID, later SEQUENCE) marked cancelled, so
// a calendar that added the original invite removes it instead of keeping a
// viewing that isn't happening.
// ORGANIZER/ATTENDEE: Outlook and Gmail ignore a cancellation that doesn't
// say who organised it and who it's for. attendee is optional here: when a
// caller leaves it out, sendEmail fills in the recipient.
// sequence: for an event that can be moved (setup calls), a higher number
// each time, so the calendar replaces the earlier version.
export function buildIcs({ uid, start, end, summary, description, location, cancelled = false, attendee, sequence }) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ViewPal//Bookings//EN",
    cancelled ? "METHOD:CANCEL" : "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}@viewpal.app`,
    `SEQUENCE:${sequence ?? (cancelled ? 1 : 0)}`,
    cancelled ? "STATUS:CANCELLED" : "STATUS:CONFIRMED",
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    organizerLine(),
    attendee ? attendeeLine(attendee) : null,
    `SUMMARY:${icsText(summary)}`,
    location ? `LOCATION:${icsText(location)}` : null,
    `DESCRIPTION:${icsText(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .map(foldLine)
    .join("\r\n");
}

// Callers that build one invite for one recipient often don't pass attendee;
// add the actual recipient so every invite we send names who it's for.
function withAttendee(ics, to) {
  if (/\r\nATTENDEE[;:]/.test(ics)) return ics;
  return ics.replace("\r\nEND:VEVENT", `\r\n${foldLine(attendeeLine(to))}\r\nEND:VEVENT`);
}

// Plain, consistent wrapper so every booking email looks the same.
export function emailLayout(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:24px;background:#f8f6f2;font-family:Arial,sans-serif;color:#1f2937;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4ddd2;border-radius:14px;padding:24px;">
      <div style="font-size:11px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#b08d57;margin-bottom:8px;">ViewPal</div>
      <h1 style="font-family:Georgia,serif;font-size:21px;color:#223a33;margin:0 0 16px;">${escapeHtml(title)}</h1>
      ${bodyHtml}
    </div>
  </body></html>`;
}

// Returns { sent: boolean }. With no RESEND_API_KEY (e.g. local dev) it logs
// and skips, so the booking flow still works end to end without sending mail.
export async function sendEmail({ to, subject, html, replyTo, ics, unsubscribe }) {
  const apiKey = process.env.RESEND_API_KEY;
  // No address (e.g. a viewing request where the buyer messaged the agent
  // themselves): nothing to send.
  if (!to) return { sent: false };

  if (!apiKey) {
    console.log(`[email skipped: no RESEND_API_KEY] to=${to} subject=${subject}`);
    return { sent: false };
  }

  const body = { from: fromEmail, to: [to], subject, html };

  if (replyTo) body.reply_to = replyTo;
  // One-click unsubscribe in Gmail / Apple Mail (RFC 8058), for the "new
  // match" and price-cut emails (_lib/email-prefs.js).
  if (unsubscribe?.oneClick) {
    body.headers = {
      "List-Unsubscribe": `<${unsubscribe.oneClick}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }

  if (ics) {
    const cancelled = ics.includes("METHOD:CANCEL");
    body.attachments = [
      {
        filename: cancelled ? "cancelled.ics" : "invite.ics",
        content: Buffer.from(withAttendee(ics, to)).toString("base64"),
      },
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
