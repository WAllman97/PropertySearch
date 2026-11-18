import os
import sys
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from supabase import create_client

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BACKEND_DIR)

from core.emailer import format_viewing_datetime, send_viewing_reminder
from core.households import member_emails, original_household_id
from core.push import send_to_household

load_dotenv(os.path.join(BACKEND_DIR, ".env"))

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# How far ahead a viewing must be to trigger a reminder. Run this job hourly:
# the first run after a viewing enters the 24h window sends the reminder,
# and reminder_sent_at stops it being sent again.
REMINDER_WINDOW_HOURS = 24


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

    original_id = original_household_id(supabase)

    for viewing in viewings:
        property_data = viewing.get("properties") or {}
        address = property_data.get("address", "unknown property")
        when = viewing.get("viewing_datetime")
        household_id = property_data.get("household_id")

        try:
            # The original household keeps its config/recipients.yaml list;
            # every other household is emailed at its members' logins.
            recipients = None
            if household_id != original_id:
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


if __name__ == "__main__":
    run_viewing_reminders()
