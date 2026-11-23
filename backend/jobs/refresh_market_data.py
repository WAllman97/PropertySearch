"""Sold-price comparisons for saved homes, from HM Land Registry open data.

Runs daily from .github/workflows/sold-price-comps.yml. By hand:

    python jobs/refresh_market_data.py              # homes not done this month
    python jobs/refresh_market_data.py --force      # recompute even if fresh
    python jobs/refresh_market_data.py --limit 20
"""

import argparse
import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

from core import sales_comps  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, default=60, help="max homes to compute comps for")
    parser.add_argument("--force", action="store_true", help="recompute comps even if fresh")
    args = parser.parse_args()

    print("Computing sold-price comparisons...")
    stats = sales_comps.refresh_comps(limit=args.limit, force=args.force)
    print("Comps:", stats)


if __name__ == "__main__":
    main()
