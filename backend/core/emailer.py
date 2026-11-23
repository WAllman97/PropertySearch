"""Viewing-reminder emails (jobs/send_viewing_reminders.py), sent with Resend.

The daily new-listing email that used to live here went with the personal
scraper (removed 23 Nov 2026, docs/DATA_SOURCES.md).
"""

import os
from datetime import datetime
from zoneinfo import ZoneInfo

import requests
import resend
from dotenv import load_dotenv

load_dotenv()

APP_URL = "https://property-search-4jcc.vercel.app/"

RESEND_API_KEY = os.getenv("RESEND_API_KEY")
FROM_EMAIL = os.getenv("FROM_EMAIL", "PropertySearch <onboarding@resend.dev>")

if not RESEND_API_KEY:
    raise ValueError("RESEND_API_KEY is missing from your .env file")

resend.api_key = RESEND_API_KEY


def safe(value, fallback="Unknown"):
    if value is None:
        return fallback

    value = str(value).strip()
    return value if value else fallback


def send_resend_email(subject, html_body, recipients):
    """
    Send email through Resend.
    """
    if not recipients:
        print("No recipients found. Email not sent.")
        return None

    response = resend.Emails.send({
        "from": FROM_EMAIL,
        "to": recipients,
        "subject": subject,
        "html": html_body,
    })

    return response


# ---------------------------------------------------------------------------
# Viewing reminders (sent ~24h before a scheduled viewing)
# ---------------------------------------------------------------------------

def format_viewing_datetime(value):
    if not value:
        return "your upcoming viewing"

    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        # Stored in UTC; show the time the viewing is actually at in London.
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(ZoneInfo("Europe/London"))
        return parsed.strftime("%a %d %b %Y at %H:%M")
    except Exception:
        return str(value)


def format_price(value):
    if value is None or value == "":
        return "Price unavailable"

    try:
        return f"£{int(value):,}"
    except (ValueError, TypeError):
        return safe(value, "Price unavailable")


def build_viewing_reminder_html(viewing):
    property_data = viewing.get("properties") or {}

    address = safe(property_data.get("address"), "your saved property")
    price = format_price(property_data.get("price"))
    listing_url = safe(property_data.get("listing_url"), "")
    image_url = property_data.get("image_url") or ""

    when = format_viewing_datetime(viewing.get("viewing_datetime"))
    agent = safe(viewing.get("estate_agent"), "Not provided")
    agent_phone = viewing.get("estate_agent_phone")
    agent_email = viewing.get("estate_agent_email")

    maps_query = requests.utils.quote(
        property_data.get("address") or ""
    )
    maps_url = f"https://www.google.com/maps/search/?api=1&query={maps_query}"

    detail_rows = [("When", when), ("Price", price), ("Agent", agent)]

    if agent_phone:
        detail_rows.append(("Phone", agent_phone))

    if agent_email:
        detail_rows.append(("Email", agent_email))

    details_html = "".join(
        f"""
        <tr>
            <td style="padding:4px 16px 4px 0;font-family:Arial,sans-serif;
                       font-size:13px;color:#6b7280;white-space:nowrap;">{label}</td>
            <td style="padding:4px 0;font-family:Arial,sans-serif;
                       font-size:14px;color:#111827;">{safe(value)}</td>
        </tr>
        """
        for label, value in detail_rows
    )

    image_html = ""
    if image_url:
        image_html = f"""
        <tr><td style="padding:0 0 16px;">
            <img src="{image_url}" width="100%"
                 style="max-width:600px;border-radius:10px;display:block;" />
        </td></tr>
        """

    listing_button = ""
    if listing_url:
        listing_button = f"""
        <a href="{listing_url}"
           style="display:inline-block;background:#111827;color:#ffffff;
                  padding:10px 18px;border-radius:7px;text-decoration:none;
                  font-family:Arial,sans-serif;font-size:13px;font-weight:bold;
                  margin-right:8px;">View listing &rarr;</a>
        """

    return f"""
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"></head>
    <body style="margin:0;padding:0;background:#f1f5f9;">
    <table width="100%" cellpadding="0" cellspacing="0"
           style="background:#f1f5f9;padding:32px 0;">
        <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0"
                   style="width:600px;max-width:600px;">
                <tr><td style="background:#dc2626;border-radius:14px 14px 0 0;
                               padding:24px 28px;">
                    <div style="font-family:Arial,sans-serif;font-size:11px;
                                font-weight:bold;text-transform:uppercase;
                                letter-spacing:1.5px;color:#fecaca;
                                margin-bottom:8px;">Viewing reminder</div>
                    <div style="font-family:Georgia,serif;font-size:24px;
                                font-weight:bold;color:#ffffff;line-height:1.25;">
                        {address}</div>
                </td></tr>
                <tr><td style="background:#ffffff;border-radius:0 0 14px 14px;
                               padding:24px 28px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                        {image_html}
                    </table>
                    <div style="font-family:Arial,sans-serif;font-size:14px;
                                color:#374151;margin-bottom:16px;">
                        You have a property viewing in about 24 hours.
                    </div>
                    <table cellpadding="0" cellspacing="0"
                           style="margin-bottom:20px;">{details_html}</table>
                    {listing_button}
                    <a href="{maps_url}"
                       style="display:inline-block;background:#f3f4f6;color:#111827;
                              padding:10px 18px;border-radius:7px;text-decoration:none;
                              font-family:Arial,sans-serif;font-size:13px;
                              font-weight:bold;">Directions</a>
                </td></tr>
                <tr><td style="font-family:Arial,sans-serif;font-size:11px;
                               color:#9ca3af;text-align:center;padding:16px 0;">
                    Automated reminder from PropertySearch.
                </td></tr>
            </table>
        </td></tr>
    </table>
    </body>
    </html>
    """


def send_viewing_reminder(viewing, recipients):
    """Send a single viewing-reminder email. Returns the Resend response."""
    property_data = viewing.get("properties") or {}
    address = safe(property_data.get("address"), "your saved property")
    when = format_viewing_datetime(viewing.get("viewing_datetime"))

    subject = f"Viewing reminder — {address} — {when}"
    html_body = build_viewing_reminder_html(viewing)

    response = send_resend_email(
        subject=subject,
        html_body=html_body,
        recipients=recipients,
    )

    print(f"Viewing reminder sent for: {address} ({when})")

    return response