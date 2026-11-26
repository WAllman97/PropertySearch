"""Daily emails for agents on a free trial (migration 034).

Agents a buyer invited get 14 days without a branch code. After that,
buyers can't book them until they add one, so we email them three times:

  day 10 ("4 days left"), day 13 ("last day tomorrow") and once the trial
  has ended ("your trial has ended"), each inviting them to book a short
  call so we can set their branch up. Replies go to CONTACT_EMAIL.

CALL_BOOKING_URL (optional): a booking page link (e.g. Google Calendar
appointment schedule). When set, the emails get a "Book a call" button.

Each email is claimed in agents.trial_emails_sent before it is sent and
given back if the send fails, the same as send_viewing_reminders.py, so a
retry never sends a second copy. Any failure fails the run (exit 1), so
GitHub emails about it.
"""

import os
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from supabase import create_client

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BACKEND_DIR)

from core.emailer import APP_URL, esc, send_resend_email

load_dotenv(os.path.join(BACKEND_DIR, ".env"))

SUPABASE_URL = os.getenv("SUPABASE_URL")
# The service key only: with the anon key, row-level security hides every
# agent and the job would quietly send nothing forever.
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

SITE = (os.getenv("APP_URL") or APP_URL).rstrip("/")
CONTACT_EMAIL = "hello@viewpal.app"
CALL_URL = (os.getenv("CALL_BOOKING_URL") or "").strip()
LONDON = ZoneInfo("Europe/London")
# The "ended" email still goes if the job missed a day or two.
ENDED_GRACE_DAYS = 3


def parse_time(value):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def which_email(ends_at, now):
    """The email due today, or None.

    By London calendar date, so "4 days left" and "ends tomorrow" are true
    whatever time of day the trial started or the job runs. "ended" goes on
    the first run after the trial has actually run out.
    """
    days_left = (ends_at.astimezone(LONDON).date() - now.astimezone(LONDON).date()).days
    if ends_at <= now:
        return "ended" if days_left >= -ENDED_GRACE_DAYS else None
    if days_left == 1:
        return "day13"
    if days_left == 4:
        return "day10"
    return None


def build_email(agent, key, bookings):
    first = (agent.get("name") or "").split(" ")[0]
    ended = key == "ended"
    if key == "day10":
        subject = "4 days left on your ViewPal trial"
        title = "4 days left on your free trial"
        lead = "Your free trial ends in 4 days."
    elif key == "day13":
        subject = "Your ViewPal trial ends tomorrow"
        title = "Last day tomorrow"
        lead = "Your free trial ends tomorrow."
    else:
        subject = "Your ViewPal trial has ended"
        title = "Your free trial has ended"
        lead = "Your free trial has ended, so buyers can't book new viewings with you at the moment."

    if bookings:
        booked = (
            f"Buyers {'booked' if ended else 'have booked'} "
            f"<strong>{bookings} viewing{'s' if bookings != 1 else ''}</strong> "
            f"with you through ViewPal {'during your trial' if ended else 'so far'}."
        )
    elif ended:
        booked = ""
    else:
        booked = "Add your viewing hours and buyers who've saved your listings can book themselves in."

    if ended:
        after = "Your listings and booked viewings are all still there. Add your branch's code and booking switches straight back on."
    else:
        after = (
            "After the trial, buyers can't book new viewings with you until you add your branch's code. "
            "Your listings and booked viewings stay either way."
        )

    mail = f'<a href="mailto:{CONTACT_EMAIL}" style="color:#223a33;">{CONTACT_EMAIL}</a>'
    if CALL_URL:
        call = (
            f'<a href="{esc(CALL_URL)}" style="color:#223a33;">Book a 10-minute call</a>, '
            f"or reply to this email, and we'll set your branch up while we talk."
        )
    else:
        call = (
            f"Reply to this email, or email {mail}, to book a 10-minute call. "
            "We'll set your branch up while we talk."
        )

    settings_url = f"{SITE}/agent?view=settings"
    button = lambda url, label, dark: (  # noqa: E731
        f'<a href="{esc(url)}" style="display:inline-block;margin:0 8px 8px 0;'
        f"background:{'#223a33' if dark else '#ffffff'};color:{'#ffffff' if dark else '#223a33'};"
        "border:1px solid #223a33;text-decoration:none;font-weight:bold;font-size:15px;"
        f'padding:12px 22px;border-radius:10px;">{esc(label)}</a>'
    )
    buttons = (button(CALL_URL, "Book a call", True) if CALL_URL else "") + button(
        settings_url, "Add my branch code", not CALL_URL
    )

    body = f"""<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f8f6f2;font-family:Arial,sans-serif;color:#1f2937;">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4ddd2;border-radius:14px;padding:24px;">
<div style="font-size:11px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#b08d57;margin-bottom:8px;">ViewPal</div>
<h1 style="font-family:Georgia,serif;font-size:21px;color:#223a33;margin:0 0 16px;">{esc(title)}</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 12px;">{('Hi ' + esc(first) + ',') if first else 'Hello,'}</p>
<p style="font-size:15px;line-height:1.5;margin:0 0 12px;">{esc(lead)} {booked}</p>
<p style="font-size:15px;line-height:1.5;margin:0 0 12px;">{esc(after)} Two ways to {'switch it back on' if ended else 'keep going'}:</p>
<ol style="font-size:15px;line-height:1.6;margin:0 0 20px;padding-left:20px;">
<li><strong>No code yet?</strong> {call}</li>
<li><strong>Have a branch code?</strong> Enter it in <a href="{esc(settings_url)}" style="color:#223a33;">Settings</a>.</li>
</ol>
<p style="margin:0;">{buttons}</p>
</div></body></html>"""
    return subject, body


def booking_count(agent_id):
    result = supabase.rpc("trial_booking_count", {"p_agent": agent_id}).execute()
    return int(result.data or 0)


def email_confirmed(agent_id):
    try:
        user = supabase.auth.admin.get_user_by_id(agent_id).user
    except Exception as error:
        print(f"Could not look up agent {agent_id[:8]}: {error}")
        return False
    return bool(user and getattr(user, "email_confirmed_at", None))


def send_trial_emails():
    now = datetime.now(timezone.utc)
    agents = (
        supabase.table("agents")
        .select("user_id, name, email, trial_ends_at, trial_emails_sent, signup_code")
        .not_.is_("trial_ends_at", "null")
        .is_("signup_code", "null")
        .execute()
    ).data or []

    failed = 0
    sent = 0
    for agent in agents:
        agent_id = agent["user_id"]
        key = which_email(parse_time(agent["trial_ends_at"]), now)
        if not key or key in (agent.get("trial_emails_sent") or []) or not agent.get("email"):
            continue
        # Only people who confirmed the address: an invite link can be used
        # with someone else's email, and they shouldn't get trial emails.
        if not email_confirmed(agent_id):
            continue

        # Claim before sending: only the run whose claim succeeds sends.
        try:
            claimed = supabase.rpc("claim_trial_email", {"p_agent": agent_id, "p_key": key}).execute().data
        except Exception as error:
            print(f"Could not claim {key} for agent {agent_id[:8]}: {error}")
            failed += 1
            continue
        if not claimed:
            continue

        try:
            subject, body = build_email(agent, key, booking_count(agent_id))
            send_resend_email(subject, body, [agent["email"]], reply_to=CONTACT_EMAIL)
            sent += 1
            print(f"Sent {key} to agent {agent_id[:8]}.")
        except Exception as error:
            print(f"Failed {key} for agent {agent_id[:8]}: {error}")
            failed += 1
            # Give the claim back so a rerun today can retry.
            try:
                supabase.rpc("release_trial_email", {"p_agent": agent_id, "p_key": key}).execute()
            except Exception as release_error:
                print(f"Could not release {key} for agent {agent_id[:8]}: {release_error}")

    print(f"{len(agents)} agent(s) on a trial; {sent} email(s) sent; {failed} failure(s).")
    return failed


if __name__ == "__main__":
    try:
        failures = send_trial_emails()
    except Exception as error:
        sys.exit(f"send_trial_emails failed: {error}")
    if failures:
        sys.exit(f"Failed: {failures} trial email(s)")
