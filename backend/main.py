import os
import yaml

from core.property_repository import save_property_to_supabase
from core.commute_calculator import calculate_commutes_for_property

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


for search in config["searches"]:
    source = search.get("source", "rightmove").lower()
    search_name = search["name"]
    search_url = search["url"]

    print(f"\nChecking search: {search_name}")
    print(f"Source: {source}")

    if source not in scraper_map:
        print(f"Skipped unsupported source: {source}")
        continue

    scraper = scraper_map[source]

    try:
        properties = scraper.fetch_search_results(search_url)
    except Exception as e:
        print(f"Search failed: {e}")
        continue

    print(f"Found {len(properties)} properties")

    property_items = list(properties.items())

    if source == "zoopla":
        property_items = property_items[:8]

    print(f"Processing {len(property_items)} properties")

    for property_id, property_url in property_items:
        unique_id = f"{source}_{property_id}"

        try:
            property_html = scraper.fetch_property_page(property_url)
        except Exception as e:
            print(f"Failed to open property page: {e}")
            continue

        passes, reason = passes_filters(property_html)

        if not passes:
            print(f"Skipped by filter: {reason} | {property_url}")
            continue

        record = scraper.build_property_record(
            property_id=unique_id,
            property_url=property_url,
            property_html=property_html,
            search_name=search_name,
            reason=reason,
        )

        record["source"] = source
        record["date_found"] = datetime.now().date().isoformat()

        try:
            result = save_property_to_supabase(record)
            print(f"Saved to Supabase: {record.get('address')}")

            if result.data:
                saved_property = result.data[0]

                try:
                    calculate_commutes_for_property(
                        property_record=saved_property,
                        force=True,
                    )
                    print(f"Commutes calculated: {record.get('address')}")
                except Exception as commute_error:
                    print(f"Commute calculation failed: {commute_error}")

                new_properties.append(saved_property)

        except Exception as e:
            print(f"Failed to save to Supabase: {e}")

        save_property(
            conn=conn,
            property_id=unique_id,
            source=source,
            url=property_url,
        )

print(f"\nFinal email list count: {len(new_properties)}")
print("Email sending disabled.")
print("\nFinished.")