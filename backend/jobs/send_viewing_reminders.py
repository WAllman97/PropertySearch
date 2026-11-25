import html
import os
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from supabase import create_client

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BACKEND_DIR)

from core.emailer import format_viewing_datetime, send_resend_email, send_viewing_reminder
from core.households import member_emails
from core.push import send_to_household

load_dotenv(os.path.join(BACKEND_DIR, ".env"))

SUPABASE_URL = os.getenv("SUPABASE_URL")
# The service key only: with the anon key, row-level security hides every
# row and the job would quietly report "nothing to send" forever.
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# How far ahead a viewing must be to trigger a reminder. Run this job hourly:
# the first run after a viewing enters the 24h window sends the reminder,
# and reminder_sent_at stops it being sent again.
REMINDER_WINDOW_HOURS = 24
LONDON = ZoneInfo("Europe/London")


def run_viewing_reminders():
    now = datetime.now(timezone.utc)
    window_end = now + timedelta(hours=REMINDER_WINDOW_HOURS)

    result = (
        supabase
        .table("property_notes")
        .select(
            "id, viewing_datetime, estate_agent, estate_agent_email, "
            "estate_agent_phone, reminder_sent_at, "
            "properties(household_id, address, price, bedrooms, listing_url, image_url)"
        )
        # gte/lte on viewing_datetime also excludes NULL viewing_datetime rows.
        .gte("viewing_datetime", now.isoformat())
        .lte("viewing_datetime", window_end.isoformat())
        .is_("reminder_sent_at", "null")
        .order("viewing_datetime")
        .execute()
    )

    viewings = result.data or []

    if not viewings:
        print("No viewings need a reminder right now.")
        return

    print(
        f"Found {len(viewings)} viewing(s) within {REMINDER_WINDOW_HOURS}h "
        f"without a reminder."
    )


    for viewing in viewings:
        property_data = viewing.get("properties") or {}
        address = property_data.get("address", "unknown property")
        when = viewing.get("viewing_datetime")
        household_id = property_data.get("household_id")

        try:
            # Every household, the original one included, is emailed at its
            # members' logins.
            recipients = member_emails(supabase, household_id)
            if not recipients:
                raise RuntimeError("no member emails for this household")
            send_viewing_reminder(viewing, recipients=recipients)

            supabase.table("property_notes").update(
                {"reminder_sent_at": now.isoformat()}
            ).eq("id", viewing["id"]).execute()

            print(f"Reminder sent and marked: {address} @ {when}")

        except Exception as error:
            # Leave reminder_sent_at unset so the next run retries.
            print(f"Failed to send reminder for {address} @ {when}: {error}")
            continue

        # Phone notification too. Best effort: the email already went and is
        # marked, so a push failure never causes a second reminder.
        try:
            pushed = send_to_household(
                supabase,
                household_id,
                title=f"Viewing: {address}",
                body=f"{format_viewing_datetime(when)}. Tap for the details.",
                url="/?view=calendar",
            )
            if pushed:
                print(f"Push sent to {pushed} phone(s).")
        except Exception as error:
            print(f"Push failed for {address} @ {when}: {error}")


RUNSHEET_FROM_HOUR = 7  # London time
RUNSHEET_UNTIL_HOUR = 12


def _esc(value):
    return html.escape(str(value or ""))


def send_agent_runsheets():
    """Each morning, email every agent the day's booked viewings in one list.

    Runs hourly with the reminders; sends once per agent per day (agents.
    runsheet_sent_on, migration 027) on the first run after 7am London.
    """
    london_now = datetime.now(LONDON)
    if not (RUNSHEET_FROM_HOUR <= london_now.hour < RUNSHEET_UNTIL_HOUR):
        return
    today = london_now.date()
    day_start = datetime.combine(today, datetime.min.time(), LONDON).astimezone(timezone.utc)
    day_end = day_start + timedelta(days=1)

    slots = (
        supabase.table("viewing_slots")
        .select(
            "id, agent_id, starts_at, ends_at, agent_listings(address), "
            "viewing_bookings(buyer_name, buyer_phone, buyer_email, status)"
        )
        .is_("cancelled_at", "null")
        .gte("starts_at", day_start.isoformat())
        .lt("starts_at", day_end.isoformat())
        .order("starts_at")
        .execute()
    ).data or []

    by_agent = {}
    for slot in slots:
        booked = [b for b in (slot.get("viewing_bookings") or []) if b.get("status") == "confirmed"]
        if booked:
            by_agent.setdefault(slot["agent_id"], []).append((slot, booked))
    if not by_agent:
        return

    agents = (
        supabase.table("agents")
        .select("user_id, name, email, runsheet_sent_on")
        .in_("user_id", list(by_agent))
        .execute()
    ).data or []

    for agent in agents:
        if agent.get("runsheet_sent_on") == today.isoformat() or not agent.get("email"):
            continue
        rows = []
        count = 0
        for slot, booked in by_agent[agent["user_id"]]:
            start = datetime.fromisoformat(slot["starts_at"].replace("Z", "+00:00")).astimezone(LONDON)
            address = (slot.get("agent_listings") or {}).get("address", "")
            for b in booked:
                count += 1
                phone = b.get("buyer_phone") or ""
                phone_html = (
                    f'<a href="tel:{_esc(phone.replace(" ", ""))}" style="color:#223a33;">{_esc(phone)}</a>'
                    if phone else ""
                )
                rows.append(
                    f'<tr><td style="padding:8px 12px 8px 0;font-weight:bold;vertical-align:top;">{start:%H:%M}</td>'
                    f'<td style="padding:8px 0;"><strong>{_esc(address)}</strong><br>'
                    f'{_esc(b.get("buyer_name"))} {phone_html}</td></tr>'
                )
        first = (agent.get("name") or "").split(" ")[0]
        body = f"""<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f8f6f2;font-family:Arial,sans-serif;color:#1f2937;">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4ddd2;border-radius:14px;padding:24px;">
<div style="font-size:11px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#b08d57;margin-bottom:8px;">PropertySearch</div>
<h1 style="font-family:Georgia,serif;font-size:21px;color:#223a33;margin:0 0 12px;">Today's viewings</h1>
<p style="margin:0 0 12px;">Morning{(' ' + _esc(first)) if first else ''}. You have {count} viewing{'s' if count != 1 else ''} today:</p>
<table style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">{''.join(rows)}</table>
<p style="margin:0;color:#6b7280;font-size:13px;">Buyers can cancel up to the last minute; you'll get an email and a notification if they do.</p>
</div></body></html>"""
        try:
            send_resend_email(f"Today: {count} viewing{'s' if count != 1 else ''}", body, [agent["email"]])
            supabase.table("agents").update({"runsheet_sent_on": today.isoformat()}).eq(
                "user_id", agent["user_id"]
            ).execute()
            print(f"Run-sheet sent to agent {agent['user_id'][:8]} ({count} viewing(s)).")
        except Exception as error:
            print(f"Run-sheet failed for agent {agent['user_id'][:8]}: {error}")


def mark_past_viewings_viewed():
    """Move homes from "Viewing booked" to "Viewed" once the viewing is over.

    Saves the buyer a tap; the Dashboard then asks how it went. Looks back a
    few days only, so a missed run catches up without rescanning history.
    """
    now = datetime.now(timezone.utc)
    result = (
        supabase
        .table("property_notes")
        .select("property_id, viewing_datetime, properties(status)")
        .gte("viewing_datetime", (now - timedelta(days=3)).isoformat())
        .lte("viewing_datetime", (now - timedelta(hours=1)).isoformat())
        .execute()
    )
    ids = [
        row["property_id"]
        for row in (result.data or [])
        if (row.get("properties") or {}).get("status") == "viewing_booked"
    ]
    if not ids:
        return
    (
        supabase.table("properties")
        .update({"status": "viewed"})
        .in_("id", ids)
        .eq("status", "viewing_booked")
        .execute()
    )
    print(f"Marked {len(ids)} home(s) as viewed.")


def roll_weekly_hours_forward():
    """Add the viewing times now due from every agent's weekly hours.

    Without this, times only roll forward when an agent opens the portal, so
    an agent away for a week leaves buyers with nothing to book.
    """
    supabase.rpc("sync_all_pattern_slots").execute()


if __name__ == "__main__":
    # Each step runs even if an earlier one fails, but any failure fails the
    # run, so GitHub emails about it instead of it going unnoticed.
    failures = []
    for step in (roll_weekly_hours_forward, mark_past_viewings_viewed, send_agent_runsheets, run_viewing_reminders):
        try:
            step()
        except Exception as error:
            print(f"{step.__name__} failed: {error}")
            failures.append(step.__name__)
    if failures:
        sys.exit(f"Failed: {', '.join(failures)}")
