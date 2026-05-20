import requests
import re
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
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.zoopla.co.uk/",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

session = requests.Session()
session.headers.update(headers)

MAX_ZOOPLA_PROPERTY_PAGES = 8

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


def extract_properties_from_search(html):
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
    details = extract_property_details(property_html)

    return {
        "id": property_id,
        "url": property_url,
        "search_name": search_name,
        "reason": reason,
        "price": details["price"],
        "address": details["address"],
        "image": details["image"]
    }