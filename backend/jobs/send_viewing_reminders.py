import os
import sys
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from supabase import create_client

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BACKEND_DIR)

from core.emailer import send_viewing_reminder

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
            "properties(address, price, bedrooms, listing_url, image_url)"
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

        try:
            send_viewing_reminder(viewing)

            supabase.table("property_notes").update(
                {"reminder_sent_at": now.isoformat()}
            ).eq("id", viewing["id"]).execute()

            print(f"Reminder sent and marked: {address} @ {when}")

        except Exception as error:
            # Leave reminder_sent_at unset so the next run retries.
            print(f"Failed to send reminder for {address} @ {when}: {error}")


if __name__ == "__main__":
    run_viewing_reminders()
