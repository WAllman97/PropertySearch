import os
import requests
from datetime import datetime, timezone, timedelta

from core.supabase_client import supabase


GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY")
GOOGLE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"

COMMUTE_MODES = {
    "transit": "TRANSIT",
    "drive": "DRIVE",
    "cycle": "BICYCLE",
    "walk": "WALK",
}


def now_utc():
    return datetime.now(timezone.utc)


def duration_to_minutes(duration):
    if not duration:
        return None

    try:
        seconds = int(str(duration).replace("s", ""))
        return round(seconds / 60)
    except Exception:
        return None


def should_recalculate(property_record, days=7):
    last_checked = property_record.get("commute_last_checked")

    if not last_checked:
        return True

    try:
        last_checked_dt = datetime.fromisoformat(last_checked.replace("Z", "+00:00"))
        return now_utc() - last_checked_dt > timedelta(days=days)
    except Exception:
        return True


def calculate_route(origin, destination, mode):
    if not GOOGLE_MAPS_API_KEY:
        return {
            "success": False,
            "minutes": None,
            "distance_meters": None,
            "error": "Missing GOOGLE_MAPS_API_KEY",
        }

    if not origin or not destination:
        return {
            "success": False,
            "minutes": None,
            "distance_meters": None,
            "error": "Missing origin or destination",
        }

    payload = {
        "origin": {"address": origin},
        "destination": {"address": destination},
        "travelMode": mode,
    }

    if mode == "DRIVE":
        payload["routingPreference"] = "TRAFFIC_AWARE"

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
    }

    try:
        response = requests.post(
            GOOGLE_ROUTES_URL,
            json=payload,
            headers=headers,
            timeout=20,
        )

        if response.status_code != 200:
            return {
                "success": False,
                "minutes": None,
                "distance_meters": None,
                "error": f"Google Routes API error {response.status_code}: {response.text}",
            }

        data = response.json()
        routes = data.get("routes") or []

        if not routes:
            return {
                "success": False,
                "minutes": None,
                "distance_meters": None,
                "error": "No route returned",
            }

        route = routes[0]

        return {
            "success": True,
            "minutes": duration_to_minutes(route.get("duration")),
            "distance_meters": route.get("distanceMeters"),
            "error": None,
        }

    except Exception as e:
        return {
            "success": False,
            "minutes": None,
            "distance_meters": None,
            "error": f"Commute calculation failed: {e}",
        }


def get_default_buyer_profile():
    result = (
        supabase
        .table("buyer_profiles")
        .select("*")
        .limit(1)
        .execute()
    )

    if not result.data:
        print("No buyer profile found.")
        return None

    return result.data[0]


def get_property_address(property_record):
    return (
        property_record.get("address")
        or property_record.get("display_address")
        or property_record.get("title")
    )


def calculate_all_modes_for_person(property_address, destination, person_label):
    payload = {}
    errors = []

    for mode_label, google_mode in COMMUTE_MODES.items():
        route = calculate_route(
            origin=property_address,
            destination=destination,
            mode=google_mode,
        )

        minutes_col = f"{person_label}_{mode_label}_minutes"
        distance_col = f"{person_label}_{mode_label}_distance_meters"
        status_col = f"{person_label}_{mode_label}_status"
        error_col = f"{person_label}_{mode_label}_error"

        if route.get("success"):
            payload[minutes_col] = route.get("minutes")
            payload[distance_col] = route.get("distance_meters")
            payload[status_col] = "success"
            payload[error_col] = None
        else:
            payload[status_col] = "failed"
            payload[error_col] = route.get("error")
            errors.append(f"{person_label}_{mode_label}: {route.get('error')}")

    return payload, errors


def calculate_commutes_for_property(property_record, force=False):
    if not property_record:
        print("No property record provided.")
        return None

    if not force and not should_recalculate(property_record):
        print("Commute recently checked. Skipping.")
        return None

    profile = get_default_buyer_profile()

    if not profile:
        return None

    property_address = get_property_address(property_record)

    if not property_address:
        print("Property has no usable address.")
        return None

    update_payload = {
        "commute_last_checked": now_utc().isoformat(),
        "commute_status": "success",
        "commute_error": None,
    }

    all_errors = []

    user_work_address = profile.get("user_work_address")
    partner_work_address = profile.get("partner_work_address")

    if user_work_address:
        user_payload, user_errors = calculate_all_modes_for_person(
            property_address=property_address,
            destination=user_work_address,
            person_label="user",
        )

        update_payload.update(user_payload)
        all_errors.extend(user_errors)

    if partner_work_address:
        partner_payload, partner_errors = calculate_all_modes_for_person(
            property_address=property_address,
            destination=partner_work_address,
            person_label="partner",
        )

        update_payload.update(partner_payload)
        all_errors.extend(partner_errors)

    if all_errors:
        update_payload["commute_status"] = "partial_failed"
        update_payload["commute_error"] = " | ".join(all_errors)[:2000]

    result = (
        supabase
        .table("properties")
        .update(update_payload)
        .eq("id", property_record["id"])
        .execute()
    )

    print(f"Commutes saved for property: {property_address}")
    print(update_payload)

    return result


def calculate_commutes_for_all_properties(limit=500, force=False):
    result = (
        supabase
        .table("properties")
        .select("*")
        .limit(limit)
        .execute()
    )

    if not result.data:
        print("No properties found.")
        return []

    results = []

    for index, property_record in enumerate(result.data, start=1):
        print(f"\nProcessing property {index} of {len(result.data)}")

        output = calculate_commutes_for_property(
            property_record=property_record,
            force=force,
        )

        results.append(output)

    return results

def calculate_commutes_for_property_id(property_id, force=True):
    result = (
        supabase
        .table("properties")
        .select("*")
        .eq("id", property_id)
        .single()
        .execute()
    )

    if not result.data:
        print(f"No property found for id: {property_id}")
        return None

    return calculate_commutes_for_property(
        property_record=result.data,
        force=force,
    )


if __name__ == "__main__":
    calculate_commutes_for_all_properties(limit=500, force=True)