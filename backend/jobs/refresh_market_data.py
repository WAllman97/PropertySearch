"""Backfill / refresh price tracking and sold-price comparisons.

The daily scraper (main.py) does both automatically. Run this by hand after
applying migration 005, or to force a refresh:

    python -m jobs.refresh_market_data                  # listings then comps
    python -m jobs.refresh_market_data --comps-only --force
    python -m jobs.refresh_market_data --listings-limit 20 --comps-limit 20
"""

import argparse
import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

from core import listing_tracker, sales_comps  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--listings-limit", type=int, default=200, help="max Rightmove pages to re-read")
    parser.add_argument("--comps-limit", type=int, default=200, help="max properties to compute comps for")
    parser.add_argument("--force", action="store_true", help="recompute comps even if fresh, re-read listings checked today")
    parser.add_argument("--comps-only", action="store_true")
    parser.add_argument("--listings-only", action="store_true")
    args = parser.parse_args()

    if not args.comps_only:
        print("Refreshing active Rightmove listings...")
        stats = listing_tracker.refresh_active_listings(
            max_age_hours=0 if args.force else 20,
            limit=args.listings_limit,
        )
        print("Listings:", stats)

    if not args.listings_only:
        print("\nComputing sold-price comparisons...")
        stats = sales_comps.refresh_comps(limit=args.comps_limit, force=args.force)
        print("Comps:", stats)


if __name__ == "__main__":
    main()
