from core.commute_calculator import calculate_commutes_for_all_properties


def handler(request):
    try:
        calculate_commutes_for_all_properties(limit=5000, force=True)

        return {
            "success": True,
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
        }