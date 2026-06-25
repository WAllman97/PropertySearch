from core.supabase_client import supabase
from core.commute_calculator import calculate_commutes_for_property_id


SKIP_STATUSES = ["ignored", "archived", "lost"]


def should_skip_property(listing_url: str) -> bool:
    if not listing_url:
        return False

    result = (
        supabase
        .table("properties")
        .select("status")
        .eq("listing_url", listing_url)
        .execute()
    )

    if not result.data:
        return False

    status = result.data[0].get("status")
    return status in SKIP_STATUSES


def save_property_to_supabase(record: dict):
    listing_url = record.get("url")

    if should_skip_property(listing_url):
        print(f"Skipped previously ignored/archived/lost: {listing_url}")
        return None

    payload = {
        "source": record.get("source", "rightmove"),
        "listing_id": record.get("id"),
        "title": record.get("address"),
        "address": record.get("address"),
        "price": clean_price(record.get("price")),
        "bedrooms": record.get("bedrooms"),
        "image_url": record.get("image"),
        "listing_url": listing_url,
        "date_found": record.get("date_found"),
    }

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
            print(f"Calculating commute for: {address}")
            calculate_commutes_for_property_id(property_id, force=True)
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