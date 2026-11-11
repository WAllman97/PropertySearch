"""AI first-pass triage scoring for properties.

Claude reads a listing (description, price, bedrooms, main photo, commute
times) plus the buyer's brief and proposes the five scores the app already
uses (location, quality, commute, value, future fit), each with a one-line
reason. The proposal is stored in `ai_scores`; it is copied into the
`score_*` columns only while the user hasn't scored the property by hand
(`scores_source` is not 'manual'), so manual scores are never overwritten.
"""

import json
import os
from datetime import datetime, timezone

import yaml
from pydantic import BaseModel, ValidationError

from core.supabase_client import supabase


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MODEL = "claude-opus-5-5"

SCORE_FIELDS = ["location", "quality", "commute", "value", "future_fit"]

PERSON_LABELS = {"user": "Buyer", "partner": "Partner"}
COMMUTE_MODE_LABELS = ["transit", "drive", "cycle", "walk"]


class DimensionScore(BaseModel):
    score: int
    reason: str


class TriageResult(BaseModel):
    location: DimensionScore
    quality: DimensionScore
    commute: DimensionScore
    value: DimensionScore
    future_fit: DimensionScore
    summary: str
    red_flags: list[str]


def _dimension_schema(description):
    return {
        "type": "object",
        "description": description,
        "properties": {
            "score": {"type": "integer", "description": "1 (weak) to 10 (excellent)"},
            "reason": {"type": "string", "description": "One short sentence."},
        },
        "required": ["score", "reason"],
        "additionalProperties": False,
    }


OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "location": _dimension_schema("Area, feel, amenities, safety"),
        "quality": _dimension_schema("Layout, light, storage, garden, noise, condition"),
        "commute": _dimension_schema("Buyer and partner commutes, transport links"),
        "value": _dimension_schema("Price versus alternatives and potential upside"),
        "future_fit": _dimension_schema("5+ year suitability, space, schools, flexibility"),
        "summary": {
            "type": "string",
            "description": "Two sentences max: is this worth a viewing, and why.",
        },
        "red_flags": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Concrete concerns worth checking (lease, main road, "
            "needs work, small garden...). Empty if none.",
        },
    },
    "required": ["location", "quality", "commute", "value", "future_fit", "summary", "red_flags"],
    "additionalProperties": False,
}


SYSTEM_PROMPT = """You triage London property listings for a house hunter.

For each listing, give a first-pass score from 1 to 10 on five dimensions, \
each with one short, specific reason. The buyer will review and correct your \
scores, so be honest and calibrated rather than generous: 5 is an ordinary \
listing for this search, 8+ should be rare and clearly earned, and anything \
that fails the buyer's brief should score low on the relevant dimension.

Work only from what the listing, photo and commute data show. When a \
dimension can't be judged from the information given (for example interior \
quality with no description), score it 5 and say what is missing. Never \
invent facts about the property. Use your general knowledge of London areas \
for location and value, and say so when you do."""


def load_scoring_config():
    with open(os.path.join(BASE_DIR, "config.yaml"), "r", encoding="utf-8") as file:
        config = yaml.safe_load(file) or {}

    return config.get("ai_scoring") or {}


def is_enabled():
    config = load_scoring_config()
    return bool(config.get("enabled", True)) and bool(os.getenv("ANTHROPIC_API_KEY"))


def get_client():
    import anthropic

    return anthropic.Anthropic()


def get_buyer_profile():
    # Same profile the commutes are calculated for (pinned / unambiguous).
    from core.commute_calculator import get_default_buyer_profile

    return get_default_buyer_profile() or {}


def format_commutes(property_record):
    lines = []

    for person, label in PERSON_LABELS.items():
        parts = []

        for mode in COMMUTE_MODE_LABELS:
            minutes = property_record.get(f"{person}_{mode}_minutes")

            if minutes is not None:
                parts.append(f"{mode} {minutes} min")

        if parts:
            lines.append(f"- {label}: " + ", ".join(parts))

    return "\n".join(lines) if lines else "- Not available"


def build_prompt(property_record, buyer_profile, brief):
    price = property_record.get("price")
    price_text = f"£{price:,}" if isinstance(price, int) else "Unknown"
    description = (property_record.get("description") or "").strip()

    buyer_lines = [f"Brief: {brief.strip()}" if brief else "Brief: not provided"]

    if buyer_profile.get("user_work_address"):
        buyer_lines.append(f"Buyer works at: {buyer_profile['user_work_address']}")

    if buyer_profile.get("partner_work_address"):
        buyer_lines.append(f"Partner works at: {buyer_profile['partner_work_address']}")

    if buyer_profile.get("commute_mode"):
        buyer_lines.append(f"Preferred commute mode: {buyer_profile['commute_mode'].lower()}")

    if buyer_profile.get("has_school_commute") and buyer_profile.get("school_address"):
        buyer_lines.append(f"School run to: {buyer_profile['school_address']}")

    return f"""<buyer>
{chr(10).join(buyer_lines)}
</buyer>

<listing>
Address: {property_record.get("address") or "Unknown"}
Price: {price_text}
Bedrooms: {property_record.get("bedrooms") or "Unknown"}
Portal: {property_record.get("source") or "Unknown"}
Description and key features:
{description or "Not available"}
</listing>

<commute_times>
{format_commutes(property_record)}
</commute_times>

Score this listing."""


def build_content(prompt, image_url):
    content = []

    if image_url and str(image_url).startswith("https://"):
        content.append({"type": "image", "source": {"type": "url", "url": image_url}})

    content.append({"type": "text", "text": prompt})
    return content


def call_claude(client, content, effort):
    return client.beta.messages.create(
        model=MODEL,
        max_tokens=8000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": content}],
        output_config={
            "effort": effort,
            "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA},
        },
        # On a safety decline, re-run on a fallback model instead of
        # returning nothing.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )


def request_scores(property_record, buyer_profile, config, client=None):
    """Ask Claude for scores. Returns (TriageResult, model_used)."""
    import anthropic

    client = client or get_client()
    effort = config.get("effort", "medium")
    prompt = build_prompt(property_record, buyer_profile, config.get("brief"))
    image_url = property_record.get("image_url")

    try:
        response = call_claude(client, build_content(prompt, image_url), effort)
    except anthropic.BadRequestError as error:
        # Portal image URLs sometimes can't be fetched by the API (expired,
        # hotlink-protected). Retry once on the text alone.
        if not image_url:
            raise
        print(f"AI scoring: retrying without image ({error.message})")
        response = call_claude(client, build_content(prompt, None), effort)

    if response.stop_reason == "refusal":
        raise RuntimeError("Claude declined to score this listing")

    if response.stop_reason == "max_tokens":
        raise RuntimeError("AI scoring response was cut off (max_tokens)")

    text = next((block.text for block in response.content if block.type == "text"), "")

    try:
        result = TriageResult.model_validate(json.loads(text))
    except (json.JSONDecodeError, ValidationError) as error:
        raise RuntimeError(f"AI scoring returned unexpected output: {error}") from error

    for field in SCORE_FIELDS:
        dimension = getattr(result, field)
        dimension.score = max(1, min(10, dimension.score))

    return result, response.model


def overall_from_scores(scores):
    # Same formula as frontend/src/utils/propertyScoring.js
    return round(sum(scores) / len(scores) * 10)


def build_update(property_record, result, model_used):
    ai_scores = {field: getattr(result, field).model_dump() for field in SCORE_FIELDS}
    ai_scores["summary"] = result.summary
    ai_scores["red_flags"] = result.red_flags

    update = {
        "ai_scores": ai_scores,
        "ai_model": model_used,
        "ai_scored_at": datetime.now(timezone.utc).isoformat(),
    }

    # Never overwrite scores the user set by hand.
    if property_record.get("scores_source") != "manual":
        values = [ai_scores[field]["score"] for field in SCORE_FIELDS]

        for field, value in zip(SCORE_FIELDS, values):
            update[f"score_{field}"] = value

        update["overall_score"] = overall_from_scores(values)
        update["scores_source"] = "ai"

    return update


def score_property(property_id, buyer_profile=None, config=None, client=None, force=False):
    """Score one property and save the result. Returns the update dict, or
    None when skipped."""
    config = config if config is not None else load_scoring_config()

    record = (
        supabase.table("properties").select("*").eq("id", property_id).execute()
    ).data

    if not record:
        print(f"AI scoring: property {property_id} not found")
        return None

    property_record = record[0]

    if property_record.get("ai_scored_at") and not force:
        return None

    buyer_profile = buyer_profile if buyer_profile is not None else get_buyer_profile()
    result, model_used = request_scores(property_record, buyer_profile, config, client)
    update = build_update(property_record, result, model_used)

    supabase.table("properties").update(update).eq("id", property_id).execute()

    overall = update.get("overall_score", "kept manual")
    print(f"AI scored {property_record.get('address')}: {overall} | {result.summary}")
    return update
