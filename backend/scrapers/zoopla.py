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
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
    # Deliberately omit 'br' (Brotli): the brotli package isn't a dependency,
    # so requesting it returns bytes requests can't decode. gzip/deflate are
    # always decodable and Zoopla serves those fine.
    "Accept-Encoding": "gzip, deflate",
    "Referer": "https://www.zoopla.co.uk/",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

session = requests.Session()
session.headers.update(headers)

MAX_ZOOPLA_PROPERTY_PAGES = 8

# Structured data harvested from the search page's ld+json ItemList, keyed by
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
        .strip()
    )


def clean_url(url):
    url = clean_text(url)

    if url.startswith("https://"):
        return url

    if url.startswith("/"):
        return "https://www.zoopla.co.uk" + url

    return "https://www.zoopla.co.uk/" + url


def canonical_property_url(raw_url):
    """Reduce any Zoopla listing URL to the stable canonical form
    https://www.zoopla.co.uk/for-sale/details/<id>/."""
    raw_url = clean_text(raw_url)

    match = re.search(r'/for-sale/details/(\d+)', raw_url)

    if match:
        return f"https://www.zoopla.co.uk/for-sale/details/{match.group(1)}/"

    return clean_url(raw_url)


# ---------------------------------------------------------------------------
# ld+json ItemList (preferred) extraction
# ---------------------------------------------------------------------------

def find_item_lists(node, out):
    """Recursively collect any schema.org ItemList nodes with elements."""
    if isinstance(node, dict):
        if node.get("@type") == "ItemList" and node.get("itemListElement"):
            out.append(node)

        for value in node.values():
            find_item_lists(value, out)

    elif isinstance(node, list):
        for value in node:
            find_item_lists(value, out)


def extract_ld_json_products(html):
    """Return the list of listing 'item' dicts from the search page's
    ld+json ItemList, or [] if none is found."""
    blocks = re.findall(
        r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
        html,
        flags=re.DOTALL,
    )

    products = []

    for block in blocks:
        try:
            data = json.loads(block)
        except Exception:
            continue

        item_lists = []
        find_item_lists(data, item_lists)

        for item_list in item_lists:
            for element in item_list["itemListElement"]:
                item = element.get("item") if isinstance(element, dict) else None

                if isinstance(item, dict) and item.get("url"):
                    products.append(item)

    return products


def bedrooms_from_name(name):
    match = re.search(r'(\d+)\s*bed', name or "", flags=re.IGNORECASE)
    return int(match.group(1)) if match else None


def price_from_offers(item):
    offers = item.get("offers") or {}
    price = offers.get("price")

    if not price:
        return ""

    digits = "".join(char for char in str(price) if char.isdigit())

    if not digits:
        return ""

    return f"£{int(digits):,}"


def address_from_item(item):
    related = item.get("isRelatedTo") or {}
    return clean_text(related.get("address") or item.get("name") or "")


# ---------------------------------------------------------------------------
# Legacy regex extraction (fallback if the ld+json ItemList is missing/changed)
# ---------------------------------------------------------------------------

def extract_properties_regex(html):
    results = {}

    listing_urls = re.findall(
        r'(/for-sale/details/\d+[^"\\]*)',
        html
    )

    for url in listing_urls:
        match = re.search(r'/details/(\d+)', url)

        if match:
            property_id = match.group(1)
            results[property_id] = clean_url(url)

    escaped_urls = re.findall(
        r'(\\u002Ffor-sale\\u002Fdetails\\u002F\d+[^"\\]*)',
        html
    )

    for url in escaped_urls:
        url = clean_text(url)
        match = re.search(r'/details/(\d+)', url)

        if match:
            property_id = match.group(1)
            results[property_id] = clean_url(url)

    return results


def extract_properties_from_search(html):
    products = extract_ld_json_products(html)

    if products:
        results = {}

        for item in products:
            url = canonical_property_url(item.get("url"))
            match = re.search(r'/for-sale/details/(\d+)', url)

            if not match:
                continue

            property_id = match.group(1)
            results[property_id] = url

            _SEARCH_CACHE[url] = {
                "price": price_from_offers(item),
                "address": address_from_item(item),
                "bedrooms": bedrooms_from_name(item.get("name")),
                "image": clean_text(item.get("image") or ""),
            }

        if results:
            return results

    # Fall back to the legacy regex if the ld+json ItemList is absent/empty.
    return extract_properties_regex(html)


def fetch_search_results(search_url):
    time.sleep(random.uniform(8, 15))

    response = session.get(
        search_url,
        timeout=30,
        verify=False
    )

    response.raise_for_status()

    return extract_properties_from_search(response.text)


def fetch_property_page(property_url):
    time.sleep(random.uniform(8, 15))

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
        r'"price"\s*:\s*"?£?([\d,]+)"?',
        r'"formattedPrice"\s*:\s*"([^"]+)"',
        r'£[\d,]+'
    ]

    price = ""

    for pattern in price_patterns:
        match = re.search(pattern, property_html)

        if match:
            price = match.group(1) if match.lastindex else match.group(0)
            break

    if price and not price.startswith("£"):
        price = f"£{price}"

    details["price"] = price if price else "Unknown"
    details["address"] = extract_location(property_html)

    image_patterns = [
        r'(https://lid\.zoocdn\.com/[^"\s,]+?\.(?:jpg|jpeg|png|webp))',
        r'"src"\s*:\s*"(https://lid\.zoocdn\.com/[^"]+?\.(?:jpg|jpeg|png|webp))',
        r'"original"\s*:\s*"(https://lid\.zoocdn\.com/[^"]+?\.(?:jpg|jpeg|png|webp))',
        r'"url"\s*:\s*"(https://lid\.zoocdn\.com/[^"]+?\.(?:jpg|jpeg|png|webp))'
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
