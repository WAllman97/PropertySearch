import requests
import re
import json
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
}

# Structured data harvested from the search page's __NEXT_DATA__ blob,
# keyed by canonical property URL. build_property_record() reads this so we
# get reliable price/address/bedrooms/image without re-parsing each page.
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
        .strip()
    )


def clean_url(url):
    url = clean_text(url)

    if not url.startswith("https://"):
        url = "https://www.rightmove.co.uk" + url

    return url


def canonical_property_url(raw_url):
    """Reduce any Rightmove property URL to the stable canonical form
    https://www.rightmove.co.uk/properties/<id>/ (drops tracking fragments)."""
    raw_url = clean_text(raw_url)

    match = re.search(r'/properties/(\d+)', raw_url)

    if match:
        return f"https://www.rightmove.co.uk/properties/{match.group(1)}/"

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


def properties_from_next_data(data):
    try:
        return data["props"]["pageProps"]["searchResults"]["properties"] or []
    except Exception:
        return []


def price_from_json(prop):
    price = prop.get("price") or {}

    display_prices = price.get("displayPrices") or []

    if display_prices and display_prices[0].get("displayPrice"):
        return clean_text(display_prices[0]["displayPrice"])

    amount = price.get("amount")

    if amount:
        return f"£{amount:,}"

    return ""


def image_from_json(prop):
    images = prop.get("propertyImages") or {}
    return clean_text(images.get("mainImageSrc") or "")


def filter_text_from_json(prop):
    """Concatenate the descriptive fields the keyword filter runs on."""
    key_features = " ".join(
        f.get("description", "") for f in (prop.get("keyFeatures") or [])
    )

    parts = [
        prop.get("displayAddress"),
        prop.get("propertySubType"),
        prop.get("propertyTypeFullDescription"),
        prop.get("summary"),
        key_features,
    ]

    return " ".join(clean_text(part) for part in parts if part)


# ---------------------------------------------------------------------------
# Legacy regex extraction (fallback if __NEXT_DATA__ is missing/changed)
# ---------------------------------------------------------------------------

def extract_properties_regex(html):
    results = {}

    pattern_1 = re.findall(
        r'"id":(\d+).*?"propertyUrl":"(.*?)"',
        html,
        flags=re.DOTALL
    )

    for property_id, property_url in pattern_1:
        results[property_id] = clean_url(property_url)

    pattern_2 = re.findall(
        r'(/properties/\d+[^"\\]*)',
        html
    )

    for property_url in pattern_2:
        match = re.search(r'/properties/(\d+)', property_url)

        if match:
            property_id = match.group(1)
            results[property_id] = clean_url(property_url)

    return results


def extract_properties_from_search(html):
    data = extract_next_data(html)
    props = properties_from_next_data(data) if data else []

    if props:
        results = {}

        for prop in props:
            property_id = prop.get("id")
            raw_url = prop.get("propertyUrl")

            if property_id is None or not raw_url:
                continue

            property_id = str(property_id)
            url = canonical_property_url(raw_url)

            results[property_id] = url

            _SEARCH_CACHE[url] = {
                "bedrooms": prop.get("bedrooms"),
                "price": price_from_json(prop),
                "address": clean_text(prop.get("displayAddress")),
                "image": image_from_json(prop),
                "filter_text": filter_text_from_json(prop),
            }

        if results:
            return results

    # Fall back to the legacy regex if the JSON blob is absent or empty.
    return extract_properties_regex(html)


def fetch_search_results(search_url):
    response = requests.get(
        search_url,
        headers=headers,
        timeout=30,
        verify=False
    )

    response.raise_for_status()

    return extract_properties_from_search(response.text)


def fetch_property_page(property_url):
    response = requests.get(
        property_url,
        headers=headers,
        timeout=30,
        verify=False
    )

    response.raise_for_status()

    return response.text


def extract_location(property_html):
    patterns = [
        r'"displayAddress"\s*:\s*"([^"]+)"',
        r'"address"\s*:\s*"([^"]+)"',
        r'"addressDisplay"\s*:\s*"([^"]+)"',
        r'"streetAddress"\s*:\s*"([^"]+)"',
        r'"outcode"\s*:\s*"([^"]+)"',
        r'"incode"\s*:\s*"([^"]+)"',
        r'"title"\s*:\s*"([^"]+)"',
        r'<title>(.*?)</title>',
    ]

    for pattern in patterns:
        match = re.search(pattern, property_html, flags=re.DOTALL)

        if match:
            value = clean_text(match.group(1))

            if value:
                return value

    return "Unknown location"


def extract_property_details(property_html):
    details = {}

    price_patterns = [
        r'"displayPrice"\s*:\s*"([^"]+)"',
        r'"price"\s*:\s*"([^"]+)"',
        r'"formattedPrice"\s*:\s*"([^"]+)"',
        r'£[\d,]+'
    ]

    price = ""

    for pattern in price_patterns:
        match = re.search(pattern, property_html)

        if match:
            price = match.group(1) if match.lastindex else match.group(0)
            break

    details["price"] = price if price else "Unknown"
    details["address"] = extract_location(property_html)

    image_patterns = [
        r'"srcUrl"\s*:\s*"([^"]+)"',
        r'"url"\s*:\s*"(https://media\.rightmove\.co\.uk[^"]+)"',
        r'(https://media\.rightmove\.co\.uk/[^"\\]+?\.(?:jpg|jpeg|png|webp)[^"\\]*)'
    ]

    image = ""

    for pattern in image_patterns:
        match = re.search(pattern, property_html)

        if match:
            image = match.group(1)
            break

    image = clean_text(image)

    details["image"] = image if image else ""

    return details


def fetch_listings(search_url):
    """Return a list of listing dicts (id, url, price, address, bedrooms,
    image, filter_text) using only the search page — no per-property fetch —
    when the structured data is available. Falls back to fetching each detail
    page if a listing isn't in the search cache (e.g. JSON changed)."""
    id_url = fetch_search_results(search_url)

    listings = []

    for property_id, url in id_url.items():
        cached = _SEARCH_CACHE.get(url)

        if cached and cached.get("filter_text"):
            listings.append({
                "id": property_id,
                "url": url,
                "price": cached.get("price") or "Unknown",
                "address": cached.get("address") or "Unknown location",
                "bedrooms": cached.get("bedrooms"),
                "image": cached.get("image") or "",
                "filter_text": cached["filter_text"],
            })
            continue

        # Fallback: no structured data for this listing, fetch the page.
        try:
            page = fetch_property_page(url)
        except Exception:
            continue

        details = extract_property_details(page)
        listings.append({
            "id": property_id,
            "url": url,
            "price": details["price"],
            "address": details["address"],
            "bedrooms": None,
            "image": details["image"],
            "filter_text": page,
        })

    return listings


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
