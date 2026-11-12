"""Local sold-price comparisons from HM Land Registry Price Paid Data.

For a listing with a location (Rightmove gives lat/lng and the full
postcode), find every postcode within ~500m (postcodes.io), pull the sales
in those postcodes from Land Registry's open SPARQL endpoint, keep the same
property type, and summarise: median / quartiles / count, the nearest
recent sales, and how the asking price compares to the median.

Land Registry doesn't record bedrooms, so property type (flat / terraced /
semi / detached) is the like-for-like filter, and the UI always shows the
sale count behind any figure. Data lags ~1-2 months; England & Wales only.

Contains HM Land Registry data (c) Crown copyright and database right.
Licensed under the Open Government Licence v3.0.
"""

import re
import statistics
from datetime import date, datetime, timedelta, timezone

import requests

from core.supabase_client import supabase

POSTCODES_IO = "https://api.postcodes.io"
LAND_REGISTRY_SPARQL = "https://landregistry.data.gov.uk/landregistry/query"

RADIUS_M = 500            # postcodes.io radius search (max 2000, max 100 results)
WINDOW_MONTHS = 24        # preferred look-back
WIDE_WINDOW_MONTHS = 48   # used when the preferred window has too few sales
MIN_SALES = 8             # below this, widen the window
MAX_AGE_DAYS = 30         # recompute a property's comps monthly

INACTIVE_STATUSES = ("ignored", "archived", "lost")

# properties.property_type -> Land Registry propertyType values
LR_TYPES = {
    "flat": {"flat-maisonette"},
    "terraced": {"terraced"},
    "semi-detached": {"semi-detached"},
    "detached": {"detached"},
    "house": {"terraced", "semi-detached", "detached"},
}
ALL_RESIDENTIAL = {"flat-maisonette", "terraced", "semi-detached", "detached"}

TYPE_LABELS = {
    "flat-maisonette": "flat",
    "terraced": "terraced",
    "semi-detached": "semi-detached",
    "detached": "detached",
}

POSTCODE_RE = re.compile(r"\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b", re.IGNORECASE)

SPARQL_QUERY = """
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
SELECT ?paon ?saon ?street ?postcode ?amount ?date ?ptype ?estate ?newbuild WHERE {
  VALUES ?postcode { %(postcodes)s }
  ?addr lrcommon:postcode ?postcode .
  ?tx lrppi:propertyAddress ?addr ;
      lrppi:pricePaid ?amount ;
      lrppi:transactionDate ?date ;
      lrppi:propertyType ?ptype ;
      lrppi:estateType ?estate ;
      lrppi:newBuild ?newbuild ;
      lrppi:transactionCategory lrppi:standardPricePaidTransaction .
  OPTIONAL { ?addr lrcommon:paon ?paon }
  OPTIONAL { ?addr lrcommon:saon ?saon }
  OPTIONAL { ?addr lrcommon:street ?street }
  FILTER (?date >= "%(since)s"^^xsd:date)
}
"""

_session = requests.Session()
_session.headers["User-Agent"] = "property-search/1.0 (sold-price comparisons)"
# Matches the scrapers: the office network intercepts TLS. GitHub Actions /
# Vercel verify normally.
_session.verify = False


def find_postcode(text):
    match = POSTCODE_RE.search(text or "")
    if not match:
        return None
    return f"{match.group(1)} {match.group(2)}".upper()


# ---------------------------------------------------------------------------
# postcodes.io
# ---------------------------------------------------------------------------

def postcode_location(postcode):
    response = _session.get(f"{POSTCODES_IO}/postcodes/{postcode}", timeout=20)
    if response.status_code == 404:
        return None
    response.raise_for_status()
    result = response.json().get("result") or {}
    if result.get("latitude") is None:
        return None
    return result["latitude"], result["longitude"]


def nearby_postcodes(latitude, longitude, radius=RADIUS_M):
    """[(postcode, distance_m)] nearest first."""
    response = _session.get(
        f"{POSTCODES_IO}/postcodes",
        params={"lat": latitude, "lon": longitude, "radius": radius, "limit": 100},
        timeout=20,
    )
    response.raise_for_status()
    results = response.json().get("result") or []
    return [(r["postcode"], round(r.get("distance") or 0)) for r in results if r.get("postcode")]


# ---------------------------------------------------------------------------
# Land Registry
# ---------------------------------------------------------------------------

def months_ago(months, today=None):
    today = today or date.today()
    return today - timedelta(days=round(months * 30.44))


def _value(binding, key):
    item = binding.get(key)
    if not item:
        return None
    return item["value"].rsplit("/", 1)[-1] if item.get("type") == "uri" else item["value"]


def fetch_sales(postcodes, since):
    if not postcodes:
        return []

    values = " ".join('"%s"' % pc.replace('"', "") for pc in postcodes)
    query = SPARQL_QUERY % {"postcodes": values, "since": since.isoformat()}

    response = _session.post(
        LAND_REGISTRY_SPARQL,
        data={"query": query},
        headers={"Accept": "application/sparql-results+json"},
        timeout=90,
    )
    response.raise_for_status()

    sales = []
    for b in response.json()["results"]["bindings"]:
        # Nominal transfers (e.g. £1) are occasionally recorded as standard.
        if float(_value(b, "amount") or 0) < 10_000:
            continue
        address = " ".join(
            part.title() for part in (_value(b, "saon"), _value(b, "paon"), _value(b, "street")) if part
        )
        sales.append({
            "address": address,
            "postcode": _value(b, "postcode"),
            "price": int(float(_value(b, "amount"))),
            "date": _value(b, "date")[:10],
            "type": _value(b, "ptype"),
            "tenure": _value(b, "estate"),
            "new_build": _value(b, "newbuild") == "true",
        })
    return sales


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

def _quantile(sorted_values, q):
    if not sorted_values:
        return None
    pos = (len(sorted_values) - 1) * q
    lo, hi = int(pos), min(int(pos) + 1, len(sorted_values) - 1)
    return round(sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo))


def summarise(sales, distances, property_type, asking_price, today=None):
    """Pure: sales (from fetch_sales) -> comps dict."""
    today = today or date.today()
    for s in sales:
        s["distance_m"] = distances.get(s["postcode"])

    recent_since = months_ago(WINDOW_MONTHS, today).isoformat()
    exact = LR_TYPES.get(property_type, ALL_RESIDENTIAL)

    # Most like-for-like first; widen the time window, then (for houses) the
    # type, until there are enough sales to say anything.
    tiers = [(exact, WINDOW_MONTHS), (exact, WIDE_WINDOW_MONTHS)]
    if exact <= LR_TYPES["house"] and exact != LR_TYPES["house"]:
        tiers += [(LR_TYPES["house"], WINDOW_MONTHS), (LR_TYPES["house"], WIDE_WINDOW_MONTHS)]

    candidates = []
    for types, window in tiers:
        chosen = [
            s for s in sales
            if s["type"] in types and (window == WIDE_WINDOW_MONTHS or s["date"] >= recent_since)
        ]
        candidates.append((types, window, chosen))
        if len(chosen) >= MIN_SALES:
            break
    else:
        # Nothing reached MIN_SALES: use whichever tier found the most.
        candidates.sort(key=lambda c: len(c[2]), reverse=True)

    wanted, window, chosen = candidates[-1] if len(candidates[-1][2]) >= MIN_SALES else candidates[0]

    prices = sorted(s["price"] for s in chosen)

    comps = {
        "count": len(prices),
        "window_months": window,
        "radius_m": RADIUS_M,
        "property_type": property_type,
        "type_basis": (
            TYPE_LABELS[next(iter(wanted))] if len(wanted) == 1
            else "house" if wanted == LR_TYPES["house"] else "all"
        ),
        "low_confidence": len(prices) < 5,
        "median": round(statistics.median(prices)) if prices else None,
        "p25": _quantile(prices, 0.25),
        "p75": _quantile(prices, 0.75),
        "latest_sale_date": max((s["date"] for s in chosen), default=None),
        # Nearest first; newest first among sales in the same postcode.
        "sales": sorted(
            chosen,
            key=lambda s: (
                s["distance_m"] if s.get("distance_m") is not None else 10**6,
                -int(s["date"].replace("-", "")),
            ),
        )[:8],
        "source": "HM Land Registry Price Paid Data",
        "computed_at": datetime.now(timezone.utc).isoformat(),
    }

    if asking_price and comps["median"]:
        comps["asking_vs_median_pct"] = round((asking_price / comps["median"] - 1) * 100, 1)

    return comps


MIN_MATCHED_SALES = 5   # bedroom-matched sales needed before widening
NEAREST_RADIUS_M = 200  # use only these when there are enough of them


FLAT_ADDRESS_RE = re.compile(
    r"^\s*(flat|room|apartment|maisonette|unit|studio|basement|ground floor|first floor|"
    r"second floor|top floor|upper|lower)\b|^\s*\d+[a-z]\b",
    re.IGNORECASE,
)


def _is_flat_sale(sale):
    return (sale.get("tenure") or "").startswith("leasehold") or bool(
        FLAT_ADDRESS_RE.search(sale.get("address") or "")
    )


def _row_text(row):
    return " ".join(filter(None, [row.get("title"), row.get("address")]))


def _bedrooms(value, text=""):
    try:
        beds = int(value)
    except (TypeError, ValueError):
        # Older rows have no bedrooms column value but the Rightmove title
        # says "2 bedroom end of terrace house for sale in ...".
        match = re.search(r"\b(\d{1,2})\s*bed", text or "", flags=re.IGNORECASE)
        if not match:
            return None
        beds = int(match.group(1))
    return beds if 0 <= beds <= 10 else None


def summarise_matched(sales, property_type, bedrooms, asking_price, radius_m, years):
    """Pure: Rightmove sold sales (already near, right type) -> comps dict
    for same-bedroom sales; falls back to +/-1 bedroom when too few."""
    if property_type == "house":
        sales = [s for s in sales if s["type"] != "flat"]
    elif property_type in LR_TYPES:
        sales = [s for s in sales if s["type"] == property_type]

    if property_type and property_type != "flat":
        # Rightmove types sales by building, so flats in a converted
        # terrace come back as "terraced". They're not house comparables.
        sales = [s for s in sales if not _is_flat_sale(s)]

    exact = [s for s in sales if s.get("bedrooms") == bedrooms]
    chosen, beds_basis = exact, f"{bedrooms}"

    # Prefer the immediate neighbourhood when it has enough sales: housing
    # stock changes street by street (an estate vs Victorian terraces), and
    # a quarter-mile median can mix the two.
    nearest = [s for s in exact if s.get("distance_m") is not None and s["distance_m"] <= NEAREST_RADIUS_M]
    if len(nearest) >= MIN_MATCHED_SALES:
        chosen, radius_m = nearest, NEAREST_RADIUS_M

    if len(exact) < MIN_MATCHED_SALES:
        near = [s for s in sales if s.get("bedrooms") is not None and abs(s["bedrooms"] - bedrooms) <= 1]
        if len(near) > len(exact):
            chosen, beds_basis = near, f"{max(bedrooms - 1, 0)}–{bedrooms + 1}"

    prices = sorted(s["price"] for s in chosen)
    comps = {
        "method": "bedrooms",
        "count": len(prices),
        "bedrooms_basis": beds_basis,
        "window_months": years * 12,
        "radius_m": radius_m,
        "property_type": property_type,
        "type_basis": property_type if property_type in LR_TYPES else "all",
        "low_confidence": len(prices) < MIN_MATCHED_SALES,
        "median": round(statistics.median(prices)) if prices else None,
        "p25": _quantile(prices, 0.25),
        "p75": _quantile(prices, 0.75),
        "latest_sale_date": max((s["date"] for s in chosen), default=None),
        "sales": sorted(
            chosen,
            key=lambda s: (
                s["distance_m"] if s.get("distance_m") is not None else 10**6,
                -int(s["date"].replace("-", "")),
            ),
        )[:8],
        "source": "Rightmove sold prices (HM Land Registry data)",
        "computed_at": datetime.now(timezone.utc).isoformat(),
    }
    if asking_price and comps["median"]:
        comps["asking_vs_median_pct"] = round((asking_price / comps["median"] - 1) * 100, 1)
    return comps


def compute_matched_comps(property_row, postcode, origin):
    """Same type + same bedrooms from Rightmove's sold search: a quarter
    mile first, half a mile if that's too thin."""
    from core import rightmove_sold

    property_type = property_row.get("property_type")
    bedrooms = _bedrooms(property_row.get("bedrooms"), _row_text(property_row))
    price = property_row.get("price")

    comps = None
    for radius_miles, max_pages in ((0.25, 3), (0.5, 4)):
        sales = rightmove_sold.fetch_sold(
            postcode, property_type, years=2, origin=origin,
            radius_miles=radius_miles, max_pages=max_pages,
        )
        comps = summarise_matched(sales, property_type, bedrooms, price, round(radius_miles * 1609), 2)
        if comps["count"] >= MIN_MATCHED_SALES and comps["bedrooms_basis"] == str(bedrooms):
            break
    return comps


def compute_comps(property_row):
    """Returns a comps dict, or None when the property has no usable location.

    Preferred: Rightmove sold prices matched on type AND bedrooms (needs a
    full postcode + bedroom count). Fallback: Land Registry by type only,
    flagged in the UI as not size-matched."""
    latitude, longitude = property_row.get("latitude"), property_row.get("longitude")
    postcode = property_row.get("postcode") or find_postcode(property_row.get("address"))

    if postcode and _bedrooms(property_row.get("bedrooms"), _row_text(property_row)) is not None:
        try:
            comps = compute_matched_comps(property_row, postcode, (latitude, longitude))
            if comps and comps["count"]:
                comps["postcode"] = postcode
                return comps
        except Exception as error:
            print(f"Rightmove sold search failed for {postcode}, using Land Registry: {error}")

    if latitude is None and postcode:
        located = postcode_location(postcode)
        if located:
            latitude, longitude = located

    if latitude is None:
        return None

    nearby = nearby_postcodes(latitude, longitude)
    distances = dict(nearby)
    sales = fetch_sales(list(distances), months_ago(WIDE_WINDOW_MONTHS))

    comps = summarise(sales, distances, property_row.get("property_type"), property_row.get("price"))
    comps["method"] = "type_only"
    comps["postcode"] = postcode
    return comps


# ---------------------------------------------------------------------------
# Batch refresh (daily job / backfill)
# ---------------------------------------------------------------------------

def _days_since(value):
    try:
        then = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None
    return (datetime.now(timezone.utc) - then).days


def refresh_comps(limit=60, max_age_days=MAX_AGE_DAYS, force=False):
    result = (
        supabase.table("properties")
        .select("id,address,title,price,bedrooms,postcode,latitude,longitude,property_type,comps_updated_at,status")
        .or_("status.is.null,status.not.in.(" + ",".join(INACTIVE_STATUSES) + ")")
        .order("comps_updated_at", desc=False, nullsfirst=True)
        .limit(500)
        .execute()
    )

    stats = {"computed": 0, "no_location": 0, "failed": 0}

    for row in result.data or []:
        if stats["computed"] >= limit:
            break

        age = _days_since(row.get("comps_updated_at"))
        if not force and age is not None and age < max_age_days:
            continue

        if row.get("latitude") is None and not (row.get("postcode") or find_postcode(row.get("address"))):
            stats["no_location"] += 1
            continue

        try:
            comps = compute_comps(row)
        except Exception as error:
            stats["failed"] += 1
            print(f"Sold-price comps failed for {row.get('address')}: {error}")
            continue

        if comps is None:
            stats["no_location"] += 1
            continue

        supabase.table("properties").update({
            "comps": comps,
            "comps_updated_at": comps["computed_at"],
        }).eq("id", row["id"]).execute()

        stats["computed"] += 1
        print(
            f"Comps: {row.get('address')} | {row.get('bedrooms')}bd {row.get('property_type')} "
            f"| {comps['count']} {comps.get('bedrooms_basis') or 'any'}-bed {comps['type_basis']} sales "
            f"within {comps['radius_m']}m | median {comps['median']} | asking {comps.get('asking_vs_median_pct')}%"
        )

    return stats
