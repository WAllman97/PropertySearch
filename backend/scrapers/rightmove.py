import requests
import re
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


def extract_properties_from_search(html):
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