"""Score properties with AI triage outside the daily scraper.

Run from backend/:
    python -m jobs.score_properties --limit 3          # score 3 unscored properties
    python -m jobs.score_properties --id 123 --force   # re-score one property
    python -m jobs.score_properties --limit 3 --dry-run  # print prompts, no API calls
"""

import argparse
import sys

from core import ai_scorer
from core.supabase_client import supabase


SKIP_STATUSES = ["ignored", "archived", "lost"]


def find_unscored(limit):
    result = (
        supabase.table("properties")
        .select("*")
        .is_("ai_scored_at", "null")
        .order("date_found", desc=True)
        .limit(limit * 3)
        .execute()
    )

    active = [p for p in result.data or [] if p.get("status") not in SKIP_STATUSES]
    return active[:limit]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--id", help="Score this property id only")
    parser.add_argument("--force", action="store_true", help="Re-score even if already scored")
    parser.add_argument("--dry-run", action="store_true", help="Print prompts without calling Claude")
    args = parser.parse_args()

    config = ai_scorer.load_scoring_config()

    if args.id:
        rows = supabase.table("properties").select("*").eq("id", args.id).execute().data
    else:
        rows = find_unscored(args.limit)

    if not rows:
        print("Nothing to score.")
        return 0

    buyer_profile = ai_scorer.get_buyer_profile()

    if args.dry_run:
        for row in rows:
            print("=" * 60)
            print(ai_scorer.build_prompt(row, buyer_profile, config.get("brief")))
        return 0

    if not ai_scorer.is_enabled():
        print("ANTHROPIC_API_KEY is not set (or ai_scoring.enabled is false).")
        return 1

    client = ai_scorer.get_client()
    failed = 0

    for row in rows:
        try:
            ai_scorer.score_property(
                row["id"],
                buyer_profile=buyer_profile,
                config=config,
                client=client,
                force=args.force or bool(args.id),
            )
        except Exception as error:
            failed += 1
            print(f"Failed: {row.get('address')}: {error}")

    print(f"Done. {len(rows) - failed} scored, {failed} failed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
