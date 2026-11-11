import os
import sys
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from supabase import create_client

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BACKEND_DIR)

from core.emailer import send_daily_email

load_dotenv(os.path.join(BACKEND_DIR, ".env"))

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)


def get_lookback_hours(frequency):
    if frequency == "weekly":
        return 24 * 7

    return 24


def should_send_today(frequency):
    today = datetime.now(timezone.utc)

    if frequency == "daily":
        return True

    if frequency == "weekly":
        return today.weekday() == 0  # Monday

    return False


def get_user_email(user_id):
    """Look up a user's sign-in email (needs the service-role key)."""
    if not user_id:
        return None

    try:
        response = supabase.auth.admin.get_user_by_id(user_id)
        return response.user.email if response and response.user else None
    except Exception as error:
        print(f"Could not look up email for user {user_id}: {error}")
        return None


def recipients_for(settings):
    candidates = [get_user_email(settings.get("user_id"))]
    candidates.extend(settings.get("extra_recipients") or [])

    return [
        email.strip()
        for email in candidates
        if email and "@" in email
    ]


def run_property_alerts():
    settings_result = (
        supabase
        .table("notification_settings")
        .select("*")
        .eq("daily_email_enabled", True)
        .execute()
    )

    settings_rows = settings_result.data or []

    if not settings_rows:
        print("No enabled notification settings found.")
        return

    # Properties aren't per-user, so everyone on the same frequency gets the
    # same email. Group by frequency and send once to the combined, de-duped
    # recipient list instead of one identical email per enabled user.
    recipients_by_frequency = {}

    for settings in settings_rows:
        frequency = settings.get("email_frequency") or "daily"

        if not should_send_today(frequency):
            print(f"Skipping user {settings.get('user_id')} - frequency is {frequency}")
            continue

        recipients = recipients_by_frequency.setdefault(frequency, [])

        for email in recipients_for(settings):
            if email.lower() not in (r.lower() for r in recipients):
                recipients.append(email)

    for frequency, recipients in recipients_by_frequency.items():
        lookback_hours = get_lookback_hours(frequency)
        since = (datetime.now(timezone.utc) - timedelta(hours=lookback_hours)).isoformat()

        properties_result = (
            supabase
            .table("properties")
            .select("*")
            .gte("created_at", since)
            # Skip ones already triaged in the app (favourited, ignored, ...).
            .or_("status.is.null,status.eq.new")
            .order("created_at", desc=True)
            .execute()
        )

        new_properties = properties_result.data or []

        print(f"{frequency} alert - found {len(new_properties)} new properties")

        if not new_properties:
            continue

        if not recipients:
            # e.g. user emails couldn't be looked up: fall back to
            # config/recipients.yaml rather than silently sending nothing.
            print(f"No recipients resolved for {frequency} alert; using recipients.yaml")
            recipients = None

        send_daily_email(new_properties, recipients=recipients, frequency=frequency)


if __name__ == "__main__":
    run_property_alerts()