"""Price-drop and time-on-market tracking.

Two sources of truth:
  * the daily search scrape (rightmove.listing_facts_from_json) for anything
    still in the search results, and
  * a per-property refresh (refresh_active_listings) that re-reads each
    active Rightmove listing's own page, so listings that have dropped out of
    the search results still get price changes, "Reduced on" dates and
    removed / sold STC status.

Every change of asking price we observe is written to price_history.
"""

import json
import random
import re
import time
from datetime import datetime, timezone

import requests

from core.supabase_client import supabase
from scrapers import rightmove

INACTIVE_STATUSES = ("ignored", "archived", "lost")

# Columns copied straight from scraped facts onto properties.
FACT_COLUMNS = (
    "latitude",
    "longitude",
    "postcode",
    "property_sub_type",
    "tenure",
    "size_sqft",
    "first_listed_at",
    "price_reduced_at",
    "listing_status",
    "bedrooms",
)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Property type
# ---------------------------------------------------------------------------

def normalise_property_type(sub_type, fallback_text=""):
    """Map portal wording onto Land Registry's categories:
    flat | terraced | semi-detached | detached, or "house" when it's a house
    of unknown form (comps then use all house types)."""
    for text in (sub_type, fallback_text):
        s = (text or "").lower()
        if not s:
            continue
        if re.search(r"flat|apartment|maisonette|penthouse|studio|duplex", s):
            return "flat"
        if re.search(r"semi[\s-]?detached", s):
            return "semi-detached"
        if re.search(r"terrace|mews|town ?house", s):
            return "terraced"
        if "detached" in s:
            return "detached"
        if re.search(r"house|bungalow|cottage", s):
            return "house"
    return None


# ---------------------------------------------------------------------------
# Rightmove property page
# ---------------------------------------------------------------------------

def _page_model(html):
    i = html.find("window.__PAGE_MODEL")
    if i < 0:
        return None
    j = html.find("{", i)
    if j < 0:
        return None
    obj, _ = json.JSONDecoder().raw_decode(html[j:])
    return obj


def _hydrate(arr):
    """The page model is a flattened graph: objects map keys to indices
    into one big array. Rebuild the nested structure."""
    memo = {}

    def resolve(idx, depth=0):
        if not isinstance(idx, int) or isinstance(idx, bool) or idx < 0 or idx >= len(arr) or depth > 80:
            return None
        if idx in memo:
            return memo[idx]
        value = arr[idx]
        if isinstance(value, dict):
            out = {}
            memo[idx] = out
            for key, ref in value.items():
                out[key] = resolve(ref, depth + 1)
            return out
        if isinstance(value, list):
            out = []
            memo[idx] = out
            out.extend(resolve(ref, depth + 1) for ref in value)
            return out
        return value

    return resolve(0)


def _uk_date_to_iso(text):
    match = re.search(r"(\d{2})/(\d{2})/(\d{4})", text or "")
    if not match:
        return None
    day, month, year = match.groups()
    return f"{year}-{month}-{day}T00:00:00+00:00"


def _price_from_text(text):
    digits = re.sub(r"[^\d]", "", text or "")
    return int(digits) if digits else None


def parse_rightmove_property_data(property_data):
    """propertyData (hydrated) -> facts dict keyed by properties columns."""
    pd = property_data or {}
    facts = {}

    location = pd.get("location") or {}
    if location.get("latitude") is not None:
        facts["latitude"] = location.get("latitude")
        facts["longitude"] = location.get("longitude")

    address = pd.get("address") or {}
    if address.get("outcode") and address.get("incode"):
        facts["postcode"] = f"{address['outcode']} {address['incode']}".upper()

    if pd.get("propertySubType"):
        facts["property_sub_type"] = pd["propertySubType"]

    if isinstance(pd.get("bedrooms"), int):
        facts["bedrooms"] = pd["bedrooms"]

    tenure = (pd.get("tenure") or {}).get("tenureType")
    if tenure:
        facts["tenure"] = tenure.replace("_", " ").title()

    for size in pd.get("sizings") or []:
        if (size or {}).get("unit") == "sqft" and size.get("minimumSize"):
            facts["size_sqft"] = int(size["minimumSize"])
            break

    price = _price_from_text((pd.get("prices") or {}).get("primaryPrice"))
    if price:
        facts["price_amount"] = price

    history = ((pd.get("listingHistory") or {}).get("listingUpdateReason") or "")
    when = _uk_date_to_iso(history)
    if when and history.lower().startswith("reduced"):
        facts["price_reduced_at"] = when
    elif when and history.lower().startswith("added"):
        facts["first_listed_at"] = when

    status = pd.get("status") or {}
    tags = " ".join(str(t) for t in (pd.get("tags") or [])).upper()
    if status.get("archived") or status.get("published") is False:
        facts["listing_status"] = "removed"
    elif "SOLD_STC" in tags or "SOLD STC" in tags:
        facts["listing_status"] = "sold_stc"
    elif "UNDER_OFFER" in tags or "UNDER OFFER" in tags:
        facts["listing_status"] = "under_offer"
    else:
        facts["listing_status"] = "live"

    return facts


class ListingBlocked(Exception):
    """Rightmove refused the request (403/429): stop the run."""


def fetch_rightmove_facts(listing_url):
    url = rightmove.canonical_property_url(listing_url)
    response = requests.get(url, headers=rightmove.headers, timeout=30, verify=False)

    if response.status_code in (404, 410):
        return {"listing_status": "removed"}

    if response.status_code in (403, 429):
        raise ListingBlocked(f"Rightmove returned {response.status_code}")

    response.raise_for_status()

    model = _page_model(response.text)
    if not model or not model.get("data"):
        raise ValueError("No page model on Rightmove property page")

    data = _hydrate(json.loads(model["data"])) or {}
    return parse_rightmove_property_data(data.get("propertyData"))


# ---------------------------------------------------------------------------
# Applying facts to a stored property
# ---------------------------------------------------------------------------

def fact_payload(facts, fallback_text=""):
    """Columns to write for these facts. Never writes None, so a thinner
    source can't blank a value a richer one stored."""
    payload = {
        key: facts[key]
        for key in FACT_COLUMNS
        if facts.get(key) not in (None, "")
    }

    property_type = normalise_property_type(facts.get("property_sub_type"), fallback_text)
    if property_type:
        payload["property_type"] = property_type

    if facts:
        payload["listing_checked_at"] = now_iso()

    return payload


def record_price(property_id, old_price, new_price, source):
    """Insert a price_history row when the asking price changed (or on
    first sight). Returns extra columns for the properties update."""
    if not new_price:
        return {}

    if old_price == new_price:
        return {}

    supabase.table("price_history").insert({
        "property_id": property_id,
        "price": new_price,
        "source": "initial" if old_price is None else source,
    }).execute()

    if old_price is None:
        return {}

    return {"last_price_change_at": now_iso()}


def apply_facts(property_row, facts, source):
    """Update one stored property from freshly fetched facts."""
    fallback = " ".join(filter(None, [property_row.get("title"), property_row.get("address")]))
    payload = fact_payload(facts, fallback)

    new_price = facts.get("price_amount")
    if new_price and facts.get("listing_status") != "removed":
        payload.update(record_price(property_row["id"], property_row.get("price"), new_price, source))
        payload["price"] = new_price
        if property_row.get("initial_price") is None:
            payload["initial_price"] = property_row.get("price") or new_price

    if payload:
        supabase.table("properties").update(payload).eq("id", property_row["id"]).execute()

    return payload


# ---------------------------------------------------------------------------
# Daily refresh of active listings
# ---------------------------------------------------------------------------

def active_rightmove_properties(limit=500):
    result = (
        supabase.table("properties")
        .select("id,title,address,listing_url,price,initial_price,status,listing_status,listing_checked_at,source")
        .eq("source", "rightmove")
        .or_("status.is.null,status.not.in.(" + ",".join(INACTIVE_STATUSES) + ")")
        .order("listing_checked_at", desc=False, nullsfirst=True)
        .limit(limit)
        .execute()
    )
    return [row for row in (result.data or []) if row.get("listing_status") != "removed"]


def _hours_since(value):
    try:
        then = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None
    return (datetime.now(timezone.utc) - then).total_seconds() / 3600


def refresh_active_listings(max_age_hours=20, limit=150, delay=(1.0, 2.5)):
    """Re-read each active Rightmove listing's page (oldest-checked first)
    to pick up price changes and removed / sold STC status. Listings checked
    within max_age_hours (e.g. by today's search scrape) are skipped."""
    stats = {"checked": 0, "price_changes": 0, "removed": 0, "failed": 0, "skipped_recent": 0}

    for row in active_rightmove_properties():
        if stats["checked"] >= limit:
            break

        age = _hours_since(row.get("listing_checked_at"))
        if age is not None and age < max_age_hours:
            stats["skipped_recent"] += 1
            continue

        try:
            facts = fetch_rightmove_facts(row["listing_url"])
        except ListingBlocked as error:
            print(f"WARNING: {error}; stopping listing refresh.")
            stats["failed"] += 1
            break
        except Exception as error:
            print(f"Listing refresh failed for {row.get('address')}: {error}")
            stats["failed"] += 1
            continue

        payload = apply_facts(row, facts, source="listing_page")
        stats["checked"] += 1

        if "last_price_change_at" in payload:
            stats["price_changes"] += 1
            print(f"Price change: {row.get('address')} {row.get('price')} -> {payload.get('price')}")

        if payload.get("listing_status") == "removed":
            stats["removed"] += 1
            print(f"Removed from Rightmove: {row.get('address')}")

        time.sleep(random.uniform(*delay))

    return stats
