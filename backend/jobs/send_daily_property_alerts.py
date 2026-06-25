import os
import sys
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from supabase import create_client

# Add backend folder to Python path so jobs/ can import core/
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BACKEND_DIR)

from core.emailer import send_daily_email


load_dotenv(os.path.join(BACKEND_DIR, ".env"))

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")

if not SUPABASE_URL:
    raise ValueError("SUPABASE_URL is missing from .env")

if not SUPABASE_KEY:
    raise ValueError("SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY is missing from .env")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)


def run_daily_property_alerts():
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()

    response = (
        supabase
        .table("properties")
        .select("*")
        .gte("created_at", since)
        .execute()
    )

    new_properties = response.data or []

    print(f"Found {len(new_properties)} new properties since {since}")

    if not new_properties:
        print("No new properties found. Email not sent.")
        return

    send_daily_email(new_properties)


if __name__ == "__main__":
    run_daily_property_alerts()