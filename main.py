import os
import yaml

from core.database import (
    init_db,
    property_seen,
    save_property,
    save_property_result,
    log_search_run
)

from core.filters import passes_filters
from core.emailer import send_daily_email

from scrapers import rightmove
from scrapers import zoopla
from scrapers import onthemarket


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

        if property_seen(conn, unique_id):
            print(f"Already seen: {unique_id}")
            continue

        #print(f"Unseen candidate: {unique_id} | {property_url}")

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
            reason=reason
        )

        record["source"] = source

        #print(record)

        new_properties.append(record)

        #print(f"Added to email list. Total now: {len(new_properties)}")

        save_property(
            conn=conn,
            property_id=unique_id,
            source=source,
            url=property_url
        )

save_property_result(conn, record)
print(f"\nFinal email list count: {len(new_properties)}")

send_daily_email(new_properties)

print("\nFinished.")