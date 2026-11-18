"""Finding asking-price cuts, shared by the daily alert email and the
price-drop push the scraper sends straight after each run."""

from core.push import send_to_household

# Properties the household has written off: no alerts for their price cuts.
PRICE_DROP_STATUSES = ("ignored", "archived", "lost")

# More drops than this in one run become a single summary notification.
MAX_SEPARATE_PUSHES = 3


def get_price_drops(supabase, since):
    """Properties whose asking price fell since `since` (new, favourites and
    booked ones alike: a cut on a favourite is the most useful alert).
    Each row gets previous_price = the asking price before the latest change."""
    changed = (
        supabase
        .table("properties")
        .select("*")
        .gte("last_price_change_at", since)
        .or_("status.is.null,status.not.in.(" + ",".join(PRICE_DROP_STATUSES) + ")")
        .order("last_price_change_at", desc=True)
        .execute()
    ).data or []

    if not changed:
        return []

    history = (
        supabase
        .table("price_history")
        .select("property_id,price,observed_at")
        .in_("property_id", [p["id"] for p in changed])
        .order("observed_at", desc=True)
        .execute()
    ).data or []

    by_property = {}
    for row in history:
        by_property.setdefault(row["property_id"], []).append(row["price"])

    drops = []
    for prop in changed:
        prices = by_property.get(prop["id"], [])
        previous = prices[1] if len(prices) > 1 else prop.get("initial_price")
        if isinstance(previous, int) and isinstance(prop.get("price"), int) and prop["price"] < previous:
            drops.append({**prop, "previous_price": previous})

    return drops


def _pounds(amount):
    return f"£{amount:,}"


def _place(prop):
    return prop.get("address") or prop.get("title") or "A property"


def price_drop_messages(drops):
    """(title, body) pairs: one per drop, or a single summary when there are
    more than MAX_SEPARATE_PUSHES so a busy morning isn't a wall of alerts."""
    if not drops:
        return []

    if len(drops) > MAX_SEPARATE_PUSHES:
        names = ", ".join(_place(p) for p in drops[:2])
        more = len(drops) - 2
        return [(
            f"{len(drops)} price drops",
            f"{names} and {more} more. Tap to see them.",
        )]

    messages = []
    for prop in drops:
        cut = prop["previous_price"] - prop["price"]
        percent = round(cut * 100 / prop["previous_price"])
        messages.append((
            f"Price drop: {_place(prop)}",
            f"{_pounds(prop['previous_price'])} → {_pounds(prop['price'])} "
            f"(down {_pounds(cut)}, {percent}%)",
        ))
    return messages


def push_price_drops(supabase, since):
    """Notify the household's phones about cuts seen since `since` (the start
    of this scraper run). Returns the number of notifications delivered."""
    sent = 0
    for title, body in price_drop_messages(get_price_drops(supabase, since)):
        sent += send_to_household(supabase, title, body, url="/?view=properties")
    return sent
