// Confirming a new account's email address. Sign-ups create the login
// unconfirmed and we email a link (Supabase's sign-up token, sent through
// Resend in our own layout). Supabase refuses password log-in until the link
// is used. The link opens /confirm in the app, which verifies the token and
// signs the person in.
//
// We use the sign-up token, not a magic link: confirming an account with a
// magic link makes Supabase clear its password (a guard against someone
// pre-registering another person's email), and a magic link for an unknown
// email quietly creates an account.
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./household.js";
import { appBaseUrl } from "./booking.js";
import { emailLayout, escapeHtml, sendEmail } from "./email.js";

const NEXT_PAGES = new Set(["/", "/agent"]);

function confirmUrl(req, tokenHash, next) {
  const params = new URLSearchParams({ token: tokenHash });
  if (NEXT_PAGES.has(next) && next !== "/") params.set("next", next);
  return `${appBaseUrl(req)}/confirm?${params}`;
}

// A fresh link for an unconfirmed login (invalidates any earlier one). The
// password must be the account's own: Supabase sets it from this call.
async function newLink(email, password) {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: "signup", email, password });
  if (error || !data?.properties?.hashed_token) throw error || new Error("No confirmation link");
  return { tokenHash: data.properties.hashed_token, name: data.user?.user_metadata?.name };
}

export async function sendConfirmEmail(req, { email, password, name, next = "/" }) {
  const link = await newLink(email, password);
  const url = confirmUrl(req, link.tokenHash, next);
  const firstName = String(name || link.name || "").trim().split(/\s+/)[0];
  const html = emailLayout(
    "Confirm your email",
    `<p style="font-size:15px;line-height:1.5;margin:0 0 20px;">
      ${firstName ? `Hi ${escapeHtml(firstName)}, tap` : "Tap"} the button to confirm
      <strong>${escapeHtml(email)}</strong> and finish setting up your account.
    </p>
    <p style="margin:0 0 24px;">
      <a href="${url}" style="display:inline-block;background:#223a33;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:10px;">Confirm my email</a>
    </p>
    <p style="font-size:13px;line-height:1.5;color:#6b7280;margin:0 0 12px;">
      The link works once and expires in an hour. If it's expired, log in and we'll offer to send a new one.
      Didn't sign up? Ignore this email and the account won't be activated.
    </p>
    <p style="font-size:12px;line-height:1.5;color:#9a9186;margin:0;word-break:break-all;">
      Button not working? Copy this into your browser:<br>${url}
    </p>`
  );
  return sendEmail({ to: email, subject: "Confirm your email for ViewPal", html });
}

// POST { action: "resend_confirmation", email, password }. The password must
// be right (checked by trying to log in: Supabase answers "email not
// confirmed" only for the correct password), so nobody can change an
// unconfirmed account's password or spam its inbox with just the address.
// Answers the same way whether or not a link was sent.
export async function handleResendConfirmation(req, res) {
  const body = req.body || {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const next = NEXT_PAGES.has(body.next) ? body.next : "/";
  const ok = { success: true, message: "If that account is waiting to be confirmed, a new link is on its way." };
  if (!email || !password) return res.status(400).json({ error: "Please add your email and password" });

  const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });

  if (data?.session) {
    await anon.auth.signOut().catch(() => {});
    return res.status(200).json({ success: true, alreadyConfirmed: true });
  }
  if (error?.status === 429) {
    return res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." });
  }
  if (error?.code !== "email_not_confirmed") return res.status(200).json(ok);

  try {
    await sendConfirmEmail(req, { email, password, next });
  } catch (sendError) {
    console.error("Resend confirmation failed:", sendError);
    return res.status(500).json({ error: "Could not send the email. Please try again." });
  }
  return res.status(200).json(ok);
}
