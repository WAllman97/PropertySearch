"""Rightmove sold-price search (/house-prices/<postcode>.html).

These are HM Land Registry sales that Rightmove has matched to its own past
listings, so most carry a bedroom count, which Land Registry alone lacks.
That's what lets a 2-bed terraced house be compared with 2-bed terraced
sales rather than with every terraced house on the street.

The page embeds its data as a React Router "turbo-stream": a flat array
where objects map "_<key index>" to value indices. decode_turbo_stream()
rebuilds the nested data.
"""

import json
import math
import random
import re
import time
from datetime import datetime

import requests

from scrapers import rightmove

BASE_URL = "https://www.rightmove.co.uk/house-prices/{slug}.html"

# properties.property_type -> Rightmove's sold-search propertyType filter
RM_TYPES = {
    "flat": "FLAT",
    "terraced": "TERRACED",
    "semi-detached": "SEMI_DETACHED",
    "detached": "DETACHED",
}

# Rightmove sold propertyType -> our type words
TYPE_FROM_RM = {
    "FLAT": "flat",
    "TERRACED": "terraced",
    "SEMI_DETACHED": "semi-detached",
    "DETACHED": "detached",
}


class SoldSearchBlocked(Exception):
    pass


def decode_turbo_stream(arr):
    memo = {}

    def resolve(idx, depth=0):
        if not isinstance(idx, int) or isinstance(idx, bool) or idx < 0 or idx >= len(arr) or depth > 150:
            return None
        if idx in memo:
            return memo[idx]
        value = arr[idx]
        if isinstance(value, dict):
            out = {}
            memo[idx] = out
            for key, ref in value.items():
                if key.startswith("_") and key[1:].isdigit():
                    key = arr[int(key[1:])]
                out[key] = resolve(ref, depth + 1)
            return out
        if isinstance(value, list):
            out = []
            memo[idx] = out
            out.extend(resolve(ref, depth + 1) for ref in value)
            return out
        return value

    return resolve(0)


def _search_results(html):
    match = re.search(r'streamController\.enqueue\((".*?")\);', html, flags=re.DOTALL)
    if not match:
        raise ValueError("No data stream on Rightmove sold-prices page")

    data = decode_turbo_stream(json.loads(json.loads(match.group(1)))) or {}

    for route in (data.get("loaderData") or {}).values():
        if isinstance(route, dict) and isinstance(route.get("searchResults"), dict):
            return route["searchResults"]

    raise ValueError("No searchResults in Rightmove sold-prices data")


def _parse_date(text):
    try:
        return datetime.strptime(text, "%d %b %Y").date()
    except Exception:
        return None


def _price(text):
    digits = re.sub(r"[^\d]", "", text or "")
    return int(digits) if digits else None


def haversine_m(lat1, lng1, lat2, lng2):
    if None in (lat1, lng1, lat2, lng2):
        return None
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(2 * r * math.asin(math.sqrt(a)))


def parse_sales(search_results, since, origin=None):
    """Flatten search results into sale dicts: one per property, using its
    latest sale on or after `since` (a date)."""
    sales = []

    for prop in search_results.get("properties") or []:
        latest = prop.get("latestTransaction") or {}
        sold_on = _parse_date(latest.get("dateSold"))
        price = _price(latest.get("displayPrice"))

        if not sold_on or not price or sold_on < since:
            continue

        location = prop.get("location") or {}
        full_address = prop.get("address") or ""
        postcode_match = re.search(r"\s*([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})$", full_address)
        street = full_address[: postcode_match.start()] if postcode_match else full_address
        sales.append({
            "address": re.sub(r",\s*London$", "", street.strip()).strip(", "),
            "postcode": postcode_match.group(1) if postcode_match else None,
            "price": price,
            "date": sold_on.isoformat(),
            "type": TYPE_FROM_RM.get(prop.get("propertyType"), (prop.get("propertyType") or "").lower()),
            "bedrooms": prop.get("bedrooms"),
            "tenure": (latest.get("tenure") or "").lower().replace("_", " "),
            "new_build": bool(latest.get("newBuild")),
            "distance_m": haversine_m(
                (origin or (None, None))[0], (origin or (None, None))[1],
                location.get("lat"), location.get("lng"),
            ),
            "url": prop.get("detailUrl"),
        })

    return sales


def fetch_sold(postcode, property_type, years=2, origin=None, radius_miles=0.25, max_pages=3, delay=(1.0, 2.0)):
    """Sales within radius_miles of a postcode in the last `years` years,
    newest first, up to max_pages x 25 sold properties."""
    slug = postcode.strip().lower().replace(" ", "-")
    today = datetime.now().date()
    since = today.replace(year=today.year - years) if not (today.month == 2 and today.day == 29) else today.replace(year=today.year - years, day=28)
    params = {"radius": radius_miles, "soldIn": years}
    if RM_TYPES.get(property_type):
        params["propertyType"] = RM_TYPES[property_type]

    sales = []
    for page in range(1, max_pages + 1):
        if page > 1:
            params["pageNumber"] = page
            time.sleep(random.uniform(*delay))

        response = requests.get(
            BASE_URL.format(slug=slug), params=params,
            headers=rightmove.headers, timeout=30, verify=False,
        )
        if response.status_code in (403, 429):
            raise SoldSearchBlocked(f"Rightmove sold search returned {response.status_code}")
        if response.status_code == 404:
            break
        response.raise_for_status()

        results = _search_results(response.text)
        sales.extend(parse_sales(results, since, origin))

        if not (results.get("pagination") or {}).get("hasNext"):
            break

    return sales
