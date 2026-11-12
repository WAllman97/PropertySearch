from core.supabase_client import supabase
from core.commute_calculator import calculate_commutes_for_property_id
from core.listing_tracker import fact_payload, record_price, now_iso


SKIP_STATUSES = ["ignored", "archived", "lost"]


def get_existing_property(listing_url: str):
    if not listing_url:
        return None

    result = (
        supabase
        .table("properties")
        .select("id,status,price,initial_price")
        .eq("listing_url", listing_url)
        .execute()
    )

    return result.data[0] if result.data else None


def save_property_to_supabase(record: dict):
    listing_url = record.get("url")
    existing = get_existing_property(listing_url)

    if existing and existing.get("status") in SKIP_STATUSES:
        print(f"Skipped previously ignored/archived/lost: {listing_url}")
        return None

    price = record.get("price_amount") or clean_price(record.get("price"))

    payload = {
        "source": record.get("source", "rightmove"),
        "listing_id": record.get("id"),
        "title": record.get("address"),
        "address": record.get("address"),
        "price": price,
        "bedrooms": record.get("bedrooms"),
        "image_url": record.get("image"),
        "listing_url": listing_url,
    }

    # Location, type, listing dates and status when the portal gave them
    # (price tracking + sold-price comparisons; see core/listing_tracker.py).
    # Type falls back to the listing title only (descriptions say things like
    # "flat roof" or "semi-detached neighbours" and would mislead).
    payload.update(fact_payload(record, record.get("address") or ""))

    old_price = existing.get("price") if existing else None
    if existing and price and old_price and price != old_price:
        payload["last_price_change_at"] = now_iso()

    if not existing or existing.get("initial_price") is None:
        payload["initial_price"] = old_price or price

    # Kept for AI triage scoring. Only sent when present so a scrape that
    # falls back to a thinner parser doesn't blank a stored description.
    description = (record.get("description") or "").strip()
    if description:
        payload["description"] = description[:5000]

    # Only stamp date_found the first time we see a listing. Re-sending it on
    # every run reset "Added X days ago" to today for anything still listed.
    if not existing:
        payload["date_found"] = record.get("date_found")

    result = (
        supabase
        .table("properties")
        .upsert(payload, on_conflict="listing_url")
        .select("*")
        .execute()
    )

    if result.data:
        property_record = result.data[0]
        property_id = property_record.get("id")
        address = property_record.get("address")

        try:
            # First sighting, or the asking price changed since last run.
            record_price(property_id, old_price if existing else None, price, source="scrape")
        except Exception as error:
            print(f"Price history write failed for {address}: {error}")

        try:
            print(f"Calculating commute for: {address}")
            calculate_commutes_for_property_id(property_id, force=False)
        except Exception as error:
            print(f"Commute calculation failed for {address}: {error}")

    return result


def clean_price(price_text):
    if not price_text:
        return None

    digits = "".join(char for char in str(price_text) if char.isdigit())

    if not digits:
        return None

    return int(digits)