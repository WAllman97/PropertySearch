garden_keywords = [
    "garden",
    "private garden",
    "rear garden",
    "patio",
    "terrace",
    "courtyard",
    "outside space"
]

positive_property_keywords = [
    "maisonette",
    "ground floor maisonette",
    "garden flat",
    "ground floor flat",
    "converted house",
    "period conversion",
    "victorian conversion",
    "edwardian conversion",
    "share of freehold"
]

block_flat_keywords = [
    "purpose built block",
    "purpose-built block",
    "apartment block",
    "modern block",
    "lift access",
    "communal entrance",
    "communal hallway",
    "concierge",
    "residents' gym",
    "residents gym",
    "communal gardens",
    "upper floor flat",
    "third floor",
    "fourth floor",
    "fifth floor",
    "sixth floor"
]


def contains_any(text, keywords):
    return any(keyword in text for keyword in keywords)


def passes_filters(property_text):
    property_text = property_text.lower()

    has_garden = contains_any(
        property_text,
        garden_keywords
    )

    has_positive_property_type = contains_any(
        property_text,
        positive_property_keywords
    )

    looks_like_block_flat = contains_any(
        property_text,
        block_flat_keywords
    )

    if not has_garden:
        return False, "No garden"

    if looks_like_block_flat and not has_positive_property_type:
        return False, "Likely block flat"

    if has_positive_property_type:
        return True, "Garden + maisonette/conversion signal"

    return True, "Garden/outside space signal"