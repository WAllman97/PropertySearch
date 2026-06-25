import os
import base64
from datetime import datetime

import requests
import urllib3
import yaml
import resend
from dotenv import load_dotenv

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

load_dotenv()

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

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.rightmove.co.uk/",
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
}


def safe(value, fallback="Unknown"):
    if value is None:
        return fallback

    value = str(value).strip()
    return value if value else fallback


def fetch_image_as_base64(url):
    """
    Fetch an image URL using browser-like headers and return a base64 data URI.
    This helps avoid email clients failing to load Rightmove CDN images directly.
    Returns an empty string on failure so the card renders without an image.
    """
    if not url or url == "Unknown":
        return ""

    try:
        response = requests.get(
            url,
            headers=HEADERS,
            timeout=10,
            verify=False
        )
        response.raise_for_status()

        content_type = response.headers.get(
            "Content-Type",
            "image/jpeg"
        ).split(";")[0]

        b64 = base64.b64encode(response.content).decode("utf-8")
        return f"data:{content_type};base64,{b64}"

    except Exception as e:
        print(f"Could not fetch image ({url[:60]}...): {e}")
        return ""


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


def build_property_card(item):
    price = safe(item.get("price"))
    address = safe(item.get("address"))
    reason = safe(item.get("reason"))
    search_name = safe(item.get("search_name"))
    source = safe(item.get("source", "Rightmove")).title()
    url = safe(item.get("url"), "#")
    bedrooms = safe(item.get("bedrooms"), "")
    commute_minutes = safe(item.get("commute_minutes"), "")
    image_src = item.get("_image_b64", "")

    details = []

    if bedrooms and bedrooms != "Unknown":
        details.append(f"{bedrooms} bed")

    if commute_minutes and commute_minutes != "Unknown":
        details.append(f"{commute_minutes} min commute")

    details.append("Added today")

    detail_line = " · ".join(details)

    image_cell = ""
    if image_src:
        image_cell = f"""
        <td width="200" valign="top" style="padding:0 20px 0 0;">
            <img src="{image_src}"
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
                                {source} &nbsp;·&nbsp; {search_name}
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
                                ✓ &nbsp;{reason}
                            </div>

                            <br>

                            <a href="https://property-search-4jcc.vercel.app/"
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


def send_daily_email(new_properties):
    """
    Send daily property alert email through Resend.

    Expects new_properties as a list of dictionaries containing:
    price, address, reason, search_name, source, url, image.
    Optional:
    bedrooms, commute_minutes.
    """
    if not new_properties:
        print("No new properties found. Email not sent.")
        return None

    print("Fetching property images...")

    for item in new_properties:
        raw_url = safe(
            item.get("image")
            or item.get("image_url")
            or item.get("thumbnail_url")
            or item.get("main_image")
            or item.get("property_image"),
            ""
        )

    item["_image_b64"] = fetch_image_as_base64(raw_url)

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
                                Daily alert &nbsp;·&nbsp; {today}
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
        recipients=EMAIL_RECIPIENTS
    )

    print(
        f"Email sent to {len(EMAIL_RECIPIENTS)} recipient(s) "
        f"with {count} properties."
    )

    return response