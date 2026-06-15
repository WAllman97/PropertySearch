from core.supabase_client import supabase
from core.commute_calculator import calculate_commutes_for_property


def main():
    result = (
        supabase
        .table("properties")
        .select("*")
        .limit(1)
        .execute()
    )

    if not result.data:
        print("No properties found in Supabase.")
        return

    property_record = result.data[0]

    print("Testing commute for:")
    print(property_record.get("address") or property_record.get("title"))

    commute_result = calculate_commutes_for_property(property_record)

    if commute_result:
        print("Commute test finished.")
    else:
        print("Commute test failed or returned nothing.")


if __name__ == "__main__":
    main()