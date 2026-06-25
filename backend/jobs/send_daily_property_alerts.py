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

    for settings in settings_rows:
        frequency = settings.get("email_frequency", "daily")

        if not should_send_today(frequency):
            print(f"Skipping user {settings.get('user_id')} - frequency is {frequency}")
            continue

        lookback_hours = get_lookback_hours(frequency)
        since = (datetime.now(timezone.utc) - timedelta(hours=lookback_hours)).isoformat()

        properties_result = (
            supabase
            .table("properties")
            .select("*")
            .gte("created_at", since)
            .execute()
        )

        new_properties = properties_result.data or []

        print(
            f"User {settings.get('user_id')} - found {len(new_properties)} properties "
            f"for {frequency} alert"
        )

        if not new_properties:
            continue

        extra_recipients = settings.get("extra_recipients") or []

        # For now, keep your yaml/main recipient handled inside emailer.py.
        # Later we should pass user.email + extra_recipients directly.
        send_daily_email(new_properties)


if __name__ == "__main__":
    run_property_alerts()