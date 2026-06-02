from core.supabase_client import supabase


def save_property_to_supabase(record: dict):
    payload = {
        "source": record.get("source", "rightmove"),
        "listing_id": record.get("id"),
        "title": record.get("address"),
        "address": record.get("address"),
        "price": clean_price(record.get("price")),
        "bedrooms": None,
        "image_url": record.get("image"),
        "listing_url": record.get("url"),
        "status": "new",
    }

    return (
        supabase
        .table("properties")
        .upsert(payload, on_conflict="listing_url")
        .execute()
    )


def clean_price(price_text):
    if not price_text:
        return None

    digits = "".join(char for char in str(price_text) if char.isdigit())

    if not digits:
        return None

    return int(digits)