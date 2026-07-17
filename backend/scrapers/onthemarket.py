import requests
import re
import json
import time
import random
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

headers = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    "Referer": "https://www.onthemarket.com/",
}

session = requests.Session()
session.headers.update(headers)

# Structured data harvested from the search page's __NEXT_DATA__ blob, keyed by
# canonical property URL. build_property_record() reads this so we get reliable
# price/address/bedrooms/image without re-parsing each detail page.
_SEARCH_CACHE = {}


def clean_text(value):
    if not value:
        return ""

    return (
        value
        .replace("\\u002F", "/")
        .replace("\\/", "/")
        .replace("&amp;", "&")
        .replace("\\u0026", "&")
        .replace("&#x27;", "'")
        .replace("&quot;", '"')
        .strip()
    )


def clean_url(url):
    url = clean_text(url)

    if url.startswith("https://"):
        return url

    if url.startswith("/"):
        return "https://www.onthemarket.com" + url

    return "https://www.onthemarket.com/" + url


def canonical_property_url(raw_url):
    """Reduce any OnTheMarket listing URL to the stable canonical form
    https://www.onthemarket.com/details/<id>/."""
    raw_url = clean_text(raw_url)

    match = re.search(r'/details/(\d+)', raw_url)

    if match:
        return f"https://www.onthemarket.com/details/{match.group(1)}/"

    return clean_url(raw_url)


# ---------------------------------------------------------------------------
# __NEXT_DATA__ (preferred) extraction
# ---------------------------------------------------------------------------

def extract_next_data(html):
    match = re.search(
        r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
        html,
        flags=re.DOTALL,
    )

    if not match:
        return None

    try:
        return json.loads(match.group(1))
    except Exception:
        return None


def listings_from_next_data(data):
    try:
        return data["props"]["initialReduxState"]["results"]["list"] or []
    except Exception:
        return []


def image_from_listing(listing):
    cover = listing.get("cover-image") or {}

    if isinstance(cover, dict):
        return clean_text(cover.get("default") or cover.get("webp") or "")

    images = listing.get("images") or []

    if images and isinstance(images[0], dict):
        return clean_text(images[0].get("default") or "")

    return ""


# ---------------------------------------------------------------------------
# Legacy regex extraction (fallback if __NEXT_DATA__ is missing/changed)
# ---------------------------------------------------------------------------

def extract_properties_regex(html):
    results = {}

    # Common OnTheMarket property URL pattern
    url_patterns = [
        r'(/details/\d+[^"\\]*)',
        r'(/for-sale/property/[^"\\]+/\d+[^"\\]*)',

    ]

    for pattern in url_patterns:
        matches = re.findall(pattern, html)

        for url in matches:
            url = clean_url(url)

            if "image-" in url or url.endswith((".jpg", ".jpeg", ".png", ".webp")):
                continue

            id_match = re.search(r'/details/(\d+)', url)

            if not id_match:
                id_match = re.search(r'/(\d+)(?:/|\?|$)', url)

            if id_match:
                property_id = id_match.group(1)
                results[property_id] = url

    # Escaped fallback
    escaped_matches = re.findall(
        r'(\\u002Fdetails\\u002F\d+[^"\\]*)',
        html
    )

    for url in escaped_matches:
        url = clean_url(url)

        id_match = re.search(r'/details/(\d+)', url)

        if id_match:
            property_id = id_match.group(1)
            results[property_id] = url

    return results


def extract_properties_from_search(html):
    data = extract_next_data(html)
    listings = listings_from_next_data(data) if data else []

    if listings:
        results = {}

        for listing in listings:
            raw_url = listing.get("details-url")

            if not raw_url:
                continue

            url = canonical_property_url(raw_url)
            match = re.search(r'/details/(\d+)', url)

            if not match:
                continue

            property_id = match.group(1)
            results[property_id] = url

            _SEARCH_CACHE[url] = {
                "price": clean_text(listing.get("price")),
                "address": clean_text(listing.get("address")),
                "bedrooms": listing.get("bedrooms"),
                "image": image_from_listing(listing),
            }

        if results:
            return results

    # Fall back to the legacy regex if the JSON blob is absent/empty.
    return extract_properties_regex(html)


def fetch_search_results(search_url):
    time.sleep(random.uniform(3, 7))

    response = session.get(
        search_url,
        timeout=30,
        verify=False
    )

    response.raise_for_status()

    return extract_properties_from_search(response.text)


def fetch_property_page(property_url):
    time.sleep(random.uniform(3, 7))

    response = session.get(
        property_url,
        timeout=30,
        verify=False
    )

    response.raise_for_status()

    return response.text


def extract_location(property_html):
    patterns = [
        r'"displayAddress"\s*:\s*"([^"]+)"',
        r'"address"\s*:\s*"([^"]+)"',
        r'"streetAddress"\s*:\s*"([^"]+)"',
        r'"name"\s*:\s*"([^"]+)"',
        r'"headline"\s*:\s*"([^"]+)"',
        r'<title>(.*?)</title>',
        r'<h1[^>]*>(.*?)</h1>',
    ]

    for pattern in patterns:
        match = re.search(pattern, property_html, flags=re.DOTALL)

        if match:
            value = clean_text(re.sub(r"<.*?>", "", match.group(1)))

            if value:
                return value

    return "Unknown location"


def extract_property_details(property_html):
    details = {}

    price_patterns = [
        r'"displayPrice"\s*:\s*"([^"]+)"',
        r'"price"\s*:\s*"([^"]+)"',
        r'"price"\s*:\s*(\d+)',
        r'£[\d,]+',
    ]

    price = ""

    for pattern in price_patterns:
        match = re.search(pattern, property_html)

        if match:
            price = match.group(1) if match.lastindex else match.group(0)
            break

    if price and price.isdigit():
        price = f"£{int(price):,}"

    details["price"] = clean_text(price) if price else "Unknown"

    details["address"] = extract_location(property_html)

    image_patterns = [
        r'(https://media\.onthemarket\.com/[^"\s,]+?\.(?:jpg|jpeg|png|webp))',
        r'(https://[^"\s,]+?onthemarket[^"\s,]+?\.(?:jpg|jpeg|png|webp))',
        r'"image"\s*:\s*"([^"]+?\.(?:jpg|jpeg|png|webp)[^"]*)"',
        r'"src"\s*:\s*"([^"]+?\.(?:jpg|jpeg|png|webp)[^"]*)"',
    ]

    image = ""

    for pattern in image_patterns:
        match = re.search(pattern, property_html)

        if match:
            image = match.group(1)
            break

    details["image"] = clean_text(image) if image else ""

    return details


def build_property_record(
    property_id,
    property_url,
    property_html,
    search_name,
    reason
):
    cached = _SEARCH_CACHE.get(property_url)

    if cached:
        record = {
            "id": property_id,
            "url": property_url,
            "search_name": search_name,
            "reason": reason,
            "price": cached.get("price") or "Unknown",
            "address": cached.get("address") or "Unknown location",
            "image": cached.get("image") or "",
            "bedrooms": cached.get("bedrooms"),
        }

        # Safety net: backfill anything the search JSON was missing from the
        # detail page so we never regress below the legacy behaviour.
        if record["address"] in ("", "Unknown location") or record["price"] in ("", "Unknown") or not record["image"]:
            details = extract_property_details(property_html)

            if record["address"] in ("", "Unknown location"):
                record["address"] = details["address"]

            if record["price"] in ("", "Unknown"):
                record["price"] = details["price"]

            if not record["image"]:
                record["image"] = details["image"]

        return record

    # No cached search data (JSON changed, or came via the regex fallback):
    # parse the detail page directly, as before.
    details = extract_property_details(property_html)

    return {
        "id": property_id,
        "url": property_url,
        "search_name": search_name,
        "reason": reason,
        "price": details["price"],
        "address": details["address"],
        "image": details["image"],
        "bedrooms": None,
    }