import os
import html
from datetime import datetime

import requests
import yaml
import resend
from dotenv import load_dotenv

load_dotenv()

APP_URL = "https://property-search-4jcc.vercel.app/"

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

recipients_path = os.path.join(
    BASE_DIR,
    "config",
    "recipients.yaml"
)

with open(recipients_path, "r", encoding="utf-8") as file:
    recipients_config = yaml.safe_load(file)

EMAIL_RECIPIENTS = recipients_config["recipients"]

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


# Order in which we pick a commute to display in the email.
# Matches the per-mode columns written by commute_calculator.py.
COMMUTE_MODE_PRIORITY = ["transit", "drive", "cycle", "walk"]


def get_primary_commute(item, person="user"):
    """Return the first available commute time (minutes) for a person,
    preferring public transport, then drive, cycle, walk."""
    for mode in COMMUTE_MODE_PRIORITY:
        minutes = item.get(f"{person}_{mode}_minutes")

        if minutes:
            return minutes

    return None


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


SOURCE_LABELS = {
    "rightmove": "Rightmove",
    "zoopla": "Zoopla",
    "onthemarket": "OnTheMarket",
    "manual": "Added manually",
}


def get_image_url(item):
    return (
        item.get("image_url")
        or item.get("image")
        or item.get("thumbnail_url")
        or item.get("main_image")
        or item.get("property_image")
        or ""
    )


def build_property_card(item):
    # Rows come straight from the properties table, so use its column names
    # (listing_url, image_url, integer price). search_name/reason are only
    # present on in-memory scraper records, so show them only when set.
    price = format_price(item.get("price"))
    address = html.escape(safe(item.get("address")))
    reason = item.get("reason")
    search_name = item.get("search_name")
    source_key = safe(item.get("source"), "").lower()
    source = SOURCE_LABELS.get(source_key, source_key.title() or "Listing")
    listing_url = item.get("listing_url") or item.get("url") or ""
    bedrooms = item.get("bedrooms")
    user_commute = get_primary_commute(item, "user")
    partner_commute = get_primary_commute(item, "partner")
    image_src = get_image_url(item)

    details = []

    if bedrooms:
        details.append(f"{bedrooms} bed")

    if user_commute:
        details.append(f"You: {user_commute} min")

    if partner_commute:
        details.append(f"Partner: {partner_commute} min")

    detail_line = " · ".join(details)

    eyebrow = source
    if search_name:
        eyebrow += f" &nbsp;·&nbsp; {html.escape(str(search_name))}"

    reason_badge = ""
    if reason:
        reason_badge = f"""
                            <div style="
                                display:inline-block;
                                background:#f0fdf4;
                                color:#166534;
                                border:1px solid #bbf7d0;
                                padding:4px 10px;
                                border-radius:20px;
                                font-family:Arial,sans-serif;
                                font-size:11px;
                                font-weight:bold;
                                letter-spacing:0.3px;
                                margin-bottom:16px;
                            ">
                                ✓ &nbsp;{html.escape(str(reason))}
                            </div>

                            <br>
        """

    listing_button = ""
    if listing_url:
        listing_button = f"""
                            <a href="{html.escape(listing_url, quote=True)}"
                                style="
                                        display:inline-block;
                                        background:#dc2626;
                                        color:#ffffff;
                                        padding:10px 20px;
                                        border-radius:7px;
                                        text-decoration:none;
                                        font-family:Arial,sans-serif;
                                        font-size:13px;
                                        font-weight:bold;
                                        letter-spacing:0.2px;
                                        margin-right:8px;
                                ">
                                    View listing &rarr;
                                </a>
        """

    image_cell = ""
    if image_src:
        image_cell = f"""
        <td width="200" valign="top" style="padding:0 20px 0 0;">
            <img src="{html.escape(image_src, quote=True)}"
                 width="200" height="150"
                 style="
                    display:block;
                    width:200px;
                    height:150px;
                    object-fit:cover;
                    border-radius:8px;
                 "
            />
        </td>
        """

    return f"""
    <table width="100%" cellpadding="0" cellspacing="0"
           style="
                background:#ffffff;
                border:1px solid #e5e7eb;
                border-radius:12px;
                margin-bottom:16px;
                overflow:hidden;
           ">
        <tr>
            <td style="padding:20px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                        {image_cell}
                        <td valign="top">

                            <div style="
                                font-family:Arial,sans-serif;
                                font-size:11px;
                                font-weight:bold;
                                text-transform:uppercase;
                                letter-spacing:0.8px;
                                color:#9ca3af;
                                margin-bottom:6px;
                            ">
                                {eyebrow}
                            </div>

                            <div style="
                                font-family:Georgia,serif;
                                font-size:24px;
                                font-weight:bold;
                                color:#111827;
                                margin-bottom:5px;
                                letter-spacing:-0.3px;
                            ">
                                {price}
                            </div>

                            <div style="
                                font-family:Arial,sans-serif;
                                font-size:14px;
                                color:#4b5563;
                                line-height:1.45;
                                margin-bottom:6px;
                            ">
                                {address}
                            </div>

                            <div style="
                                font-family:Arial,sans-serif;
                                font-size:13px;
                                color:#6b7280;
                                line-height:1.45;
                                margin-bottom:14px;
                            ">
                                {detail_line}
                            </div>

                            {reason_badge}

                            {listing_button}

                            <a href="{APP_URL}"
                                style="
                                        display:inline-block;
                                        background:#f3f4f6;
                                        color:#111827;
                                        padding:10px 20px;
                                        border-radius:7px;
                                        text-decoration:none;
                                        font-family:Arial,sans-serif;
                                        font-size:13px;
                                        font-weight:bold;
                                        letter-spacing:0.2px;
                                ">
                                    Open PropertySearch &rarr;
                                </a>

                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
    """


def send_daily_email(new_properties, recipients=None, frequency="daily"):
    """
    Send a property alert email through Resend.

    Expects new_properties as rows from the properties table (price,
    address, source, listing_url, image_url, bedrooms, per-mode commute
    columns such as user_transit_minutes). recipients defaults to
    config/recipients.yaml; frequency ("daily"/"weekly") sets the wording.
    """
    if not new_properties:
        print("No new properties found. Email not sent.")
        return None

    if recipients is None:
        recipients = EMAIL_RECIPIENTS

    alert_label = "Weekly alert" if frequency == "weekly" else "Daily alert"

    today = datetime.now().strftime("%d %B %Y")
    count = len(new_properties)

    cards_html = "".join(build_property_card(item) for item in new_properties)

    listing_word = "listing" if count == 1 else "listings"

    html_body = f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Property Alerts</title>
    </head>

    <body style="margin:0;padding:0;background:#f1f5f9;">

    <table width="100%" cellpadding="0" cellspacing="0"
           style="background:#f1f5f9;padding:32px 0;">
        <tr>
            <td align="center">

                <table width="680" cellpadding="0" cellspacing="0"
                       style="width:680px;max-width:680px;">

                    <tr>
                        <td style="
                            background:#111827;
                            border-radius:14px;
                            padding:30px 32px 28px;
                            margin-bottom:24px;
                        ">
                            <div style="
                                font-family:Arial,sans-serif;
                                font-size:11px;
                                font-weight:bold;
                                text-transform:uppercase;
                                letter-spacing:1.5px;
                                color:#6b7280;
                                margin-bottom:10px;
                            ">
                                {alert_label} &nbsp;·&nbsp; {today}
                            </div>

                            <div style="
                                font-family:Georgia,serif;
                                font-size:30px;
                                font-weight:bold;
                                color:#ffffff;
                                line-height:1.2;
                                margin-bottom:12px;
                                letter-spacing:-0.5px;
                            ">
                                {count} new {listing_word} found
                            </div>

                            <div style="
                                font-family:Arial,sans-serif;
                                font-size:14px;
                                color:#9ca3af;
                                line-height:1.5;
                            ">
                                Matching your saved property search criteria.
                            </div>
                        </td>
                    </tr>

                    <tr><td height="20"></td></tr>

                    <tr>
                        <td>
                            {cards_html}
                        </td>
                    </tr>

                    <tr>
                        <td style="
                            font-family:Arial,sans-serif;
                            font-size:11px;
                            color:#9ca3af;
                            text-align:center;
                            padding:12px 0 24px;
                        ">
                            Generated automatically by PropertySearch.
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>

    </body>
    </html>
    """

    subject = f"Property Alerts — {count} new {listing_word} — {today}"

    response = send_resend_email(
        subject=subject,
        html_body=html_body,
        recipients=recipients
    )

    print(
        f"Email sent to {len(recipients)} recipient(s) "
        f"with {count} properties."
    )

    return response


# ---------------------------------------------------------------------------
# Viewing reminders (sent ~24h before a scheduled viewing)
# ---------------------------------------------------------------------------

def format_viewing_datetime(value):
    if not value:
        return "your upcoming viewing"

    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
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


def send_viewing_reminder(viewing):
    """Send a single viewing-reminder email. Returns the Resend response."""
    property_data = viewing.get("properties") or {}
    address = safe(property_data.get("address"), "your saved property")
    when = format_viewing_datetime(viewing.get("viewing_datetime"))

    subject = f"Viewing reminder — {address} — {when}"
    html_body = build_viewing_reminder_html(viewing)

    response = send_resend_email(
        subject=subject,
        html_body=html_body,
        recipients=EMAIL_RECIPIENTS,
    )

    print(f"Viewing reminder sent for: {address} ({when})")

    return response