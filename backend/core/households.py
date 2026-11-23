"""Households (migration 013).

Each household has its own property list. Viewing reminders and
notifications go to whichever household owns the property.

The jobs use the service-role key, which bypasses row-level security, so
every query on household data must filter by household_id itself.
"""


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
