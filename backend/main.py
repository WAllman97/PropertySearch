import os
import sys
import yaml

from core.property_repository import save_property_to_supabase
from core import listing_tracker
from core import sales_comps
from scrapers.rightmove import LISTING_FACT_KEYS

from core.filters import passes_filters
from core import ai_scorer

from scrapers import rightmove
from scrapers import zoopla
from scrapers import onthemarket
from datetime import datetime


BASE_DIR = os.path.dirname(os.path.abspath(__file__))

config_path = os.path.join(BASE_DIR, "config.yaml")

with open(config_path, "r", encoding="utf-8") as file:
    config = yaml.safe_load(file)

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


def description_from(listing):
    """The listing summary + key features, for AI scoring. The scrapers'
    regex fallback puts the whole page HTML in filter_text; don't store that."""
    text = listing.get("filter_text") or ""
    lowered = text[:5000].lower()

    if "<html" in lowered or "<div" in lowered or "<script" in lowered:
        return ""

    return text


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
        listings = scraper.fetch_listings(
            search_url,
            max_pages=search.get("max_pages", 1),
        )
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
            "description": description_from(listing),
            "date_found": datetime.now().date().isoformat(),
            # Location, type, listing dates (Rightmove only for now): used
            # for price-drop tracking and sold-price comparisons.
            **{
                key: listing[key]
                for key in LISTING_FACT_KEYS
                if listing.get(key) is not None
            },
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


# ---- Price tracking: re-check active listings not in today's results ----
# Picks up price changes on listings that have dropped out of the search
# results, plus removed / sold STC. Listings saved above were stamped
# listing_checked_at just now, so they're skipped.
try:
    health["listing_refresh"] = listing_tracker.refresh_active_listings(
        limit=int(config.get("listing_refresh", {}).get("max_per_run", 150)),
    )
except Exception as e:
    health["listing_refresh"] = {"error": str(e)}
    warn(f"Listing refresh failed: {e}")

# ---- Local sold-price comparisons (HM Land Registry) ----
# Cached on each property for 30 days; new listings get theirs today.
try:
    health["sales_comps"] = sales_comps.refresh_comps(
        limit=int(config.get("sales_comps", {}).get("max_per_run", 60)),
    )
except Exception as e:
    health["sales_comps"] = {"error": str(e)}
    warn(f"Sold-price comparisons failed: {e}")


# ---- AI triage scoring ----
# Runs after scraping so commute times are already saved. Capped per run so
# the first run after enabling it (every listing unscored) can't run long or
# spend much; the rest are picked up on following days.
health["ai_scored"] = 0
health["ai_failed"] = 0

if ai_scorer.is_enabled():
    scoring_config = ai_scorer.load_scoring_config()
    max_per_run = int(scoring_config.get("max_per_run", 40))
    # Dedupe: the same listing can match more than one search.
    unscored = list({
        p["id"]: p for p in new_properties if not p.get("ai_scored_at")
    }.values())

    print(f"\nAI scoring {min(len(unscored), max_per_run)} of {len(unscored)} unscored properties")

    if unscored:
        buyer_profile = ai_scorer.get_buyer_profile()
        client = ai_scorer.get_client()

        for property_record in unscored[:max_per_run]:
            try:
                ai_scorer.score_property(
                    property_record["id"],
                    buyer_profile=buyer_profile,
                    config=scoring_config,
                    client=client,
                )
                health["ai_scored"] += 1
            except Exception as e:
                health["ai_failed"] += 1
                warn(f"AI scoring failed for {property_record.get('address')}: {e}")
else:
    print("\nAI scoring disabled (ai_scoring.enabled is false or ANTHROPIC_API_KEY unset).")


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
print(f"AI scored:        {health['ai_scored']} (failed {health['ai_failed']})")
print(f"Listing refresh:  {health.get('listing_refresh')}")
print(f"Sold-price comps: {health.get('sales_comps')}")
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
