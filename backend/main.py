import os
import sys
import yaml

from core.property_repository import save_property_to_supabase

from core.database import (
    init_db,
    save_property,
)

from core.filters import passes_filters

from scrapers import rightmove
from scrapers import zoopla
from scrapers import onthemarket
from datetime import datetime


BASE_DIR = os.path.dirname(os.path.abspath(__file__))

config_path = os.path.join(BASE_DIR, "config.yaml")
db_path = os.path.join(BASE_DIR, "seen_properties.db")

print(f"Using DB: {db_path}")

with open(config_path, "r", encoding="utf-8") as file:
    config = yaml.safe_load(file)

conn = init_db(db_path)

new_properties = []

scraper_map = {
    "rightmove": rightmove,
    "zoopla": zoopla,
    "onthemarket": onthemarket,
}

MISSING_PRICE_VALUES = {"", "unknown"}
MISSING_ADDRESS_VALUES = {"", "unknown", "unknown location"}


def warn(message):
    print(f"WARNING: {message}")


def is_missing(value, missing_values):
    if value is None:
        return True

    return str(value).strip().lower() in missing_values


# Run-health counters so a silently broken scraper is visible in the logs
# instead of looking like a genuinely quiet day.
health = {
    "searches_total": 0,
    "searches_failed": 0,
    "searches_empty": 0,
    "found_total": 0,
    "saved_total": 0,
    "missing_price": 0,
    "missing_address": 0,
}

found_by_source = {}


for search in config["searches"]:
    source = search.get("source", "rightmove").lower()
    search_name = search["name"]
    search_url = search["url"]

    print(f"\nChecking search: {search_name}")
    print(f"Source: {source}")

    if source not in scraper_map:
        warn(f"Skipped unsupported source: {source}")
        continue

    health["searches_total"] += 1
    found_by_source.setdefault(source, 0)

    scraper = scraper_map[source]

    # Searches whose URL already enforces a garden filter don't need the
    # local garden keyword re-check (see passes_filters / config.yaml).
    require_garden = not search.get("garden_prefiltered", False)

    try:
        listings = scraper.fetch_listings(search_url)
    except Exception as e:
        health["searches_failed"] += 1
        warn(f"Search request failed for {source}/{search_name}: {e}")
        continue

    found_count = len(listings)
    health["found_total"] += found_count
    found_by_source[source] += found_count

    print(f"Found {found_count} properties")

    if found_count == 0:
        health["searches_empty"] += 1
        warn(
            f"{source}/{search_name} returned 0 results — "
            f"likely scraper breakage or a blocked request."
        )
        continue

    print(f"Processing {found_count} properties")

    for listing in listings:
        property_url = listing["url"]
        unique_id = f"{source}_{listing['id']}"

        passes, reason = passes_filters(
            listing.get("filter_text", ""),
            require_garden=require_garden,
        )

        if not passes:
            print(f"Skipped by filter: {reason} | {property_url}")
            continue

        record = {
            "id": unique_id,
            "url": property_url,
            "search_name": search_name,
            "reason": reason,
            "price": listing.get("price"),
            "address": listing.get("address"),
            "image": listing.get("image"),
            "bedrooms": listing.get("bedrooms"),
            "source": source,
            "date_found": datetime.now().date().isoformat(),
        }

        # Flag records where extraction produced junk — a strong sign the
        # parsing patterns no longer match the site's markup.
        if is_missing(record.get("price"), MISSING_PRICE_VALUES):
            health["missing_price"] += 1
            warn(f"Missing price (parse issue?): {property_url}")

        if is_missing(record.get("address"), MISSING_ADDRESS_VALUES):
            health["missing_address"] += 1
            warn(f"Missing address (parse issue?): {property_url}")

        try:
            # Commutes are calculated inside save_property_to_supabase().
            result = save_property_to_supabase(record)

            if result and result.data:
                health["saved_total"] += 1
                print(f"Saved to Supabase: {record.get('address')}")
                new_properties.append(result.data[0])

        except Exception as e:
            warn(f"Failed to save to Supabase ({property_url}): {e}")

        save_property(
            conn=conn,
            property_id=unique_id,
            source=source,
            url=property_url,
        )


# ---- Run summary / health report ----
print("\n" + "=" * 48)
print("SCRAPER HEALTH SUMMARY")
print("=" * 48)
print(f"Searches run:     {health['searches_total']}")
print(f"Searches failed:  {health['searches_failed']}")
print(f"Searches empty:   {health['searches_empty']}")
print(f"Properties found: {health['found_total']}")
print(f"Properties saved: {health['saved_total']}")
print(f"Missing price:    {health['missing_price']}")
print(f"Missing address:  {health['missing_address']}")
print("Found by source:")
for source, count in found_by_source.items():
    marker = "  <-- ZERO" if count == 0 else ""
    print(f"  {source}: {count}{marker}")

# Flag sources that returned nothing at all this run.
dead_sources = [name for name, count in found_by_source.items() if count == 0]
if dead_sources:
    warn(
        "These sources returned 0 results and may be broken/blocked: "
        + ", ".join(dead_sources)
    )

print(f"\nFinal email list count: {len(new_properties)}")
print("Email sending disabled.")
print("Finished.")

# Fail the CI run loudly if every search came back empty — this is almost
# always a breakage or a block rather than a genuinely quiet day.
if health["searches_total"] > 0 and health["found_total"] == 0:
    warn("All searches returned 0 results. Exiting non-zero to flag breakage.")
    sys.exit(1)
