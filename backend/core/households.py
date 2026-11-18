"""Households (migration 013).

Each household has its own property list. The scraper, its daily email and
AI scoring only work for the original household; everything else (viewing
reminders, notifications) goes to whichever household owns the property.

The jobs use the service-role key, which bypasses row-level security, so
every query on household data must filter by household_id itself.
"""

_original_id = None


def original_household_id(supabase):
    """The household the scraper fills. Cached for the run."""
    global _original_id
    if _original_id is None:
        rows = (
            supabase.table("households").select("id").eq("is_original", True).execute().data
            or []
        )
        if not rows:
            raise RuntimeError(
                "No original household: run backend/migrations/013_households.sql first"
            )
        _original_id = rows[0]["id"]
    return _original_id


def member_ids(supabase, household_id):
    rows = (
        supabase.table("household_members")
        .select("user_id")
        .eq("household_id", household_id)
        .execute()
        .data
        or []
    )
    return [r["user_id"] for r in rows]


def member_emails(supabase, household_id):
    """Login emails of everyone in a household."""
    emails = []
    for user_id in member_ids(supabase, household_id):
        try:
            user = supabase.auth.admin.get_user_by_id(user_id).user
        except Exception as error:
            print(f"Could not look up household member {user_id}: {error}")
            continue
        if user and user.email:
            emails.append(user.email)
    return emails
