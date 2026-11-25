import html
import os
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from supabase import create_client

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BACKEND_DIR)

from core.emailer import APP_URL, format_viewing_datetime, send_resend_email, send_viewing_reminder
from core.households import member_emails
from core.push import send_to_household, send_to_tokens

load_dotenv(os.path.join(BACKEND_DIR, ".env"))

SUPABASE_URL = os.getenv("SUPABASE_URL")
# The service key only: with the anon key, row-level security hides every
# row and the job would quietly report "nothing to send" forever.
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# How far ahead a viewing must be to trigger a reminder. Run this job hourly:
# the first run after a viewing enters the 24h window sends the reminder,
# and reminder_sent_at stops it being sent again.
REMINDER_WINDOW_HOURS = 24
LONDON = ZoneInfo("Europe/London")


def run_viewing_reminders():
    now = datetime.now(timezone.utc)
    window_end = now + timedelta(hours=REMINDER_WINDOW_HOURS)

    result = (
        supabase
        .table("property_notes")
        .select(
            "id, viewing_datetime, estate_agent, estate_agent_email, "
            "estate_agent_phone, reminder_sent_at, "
            "properties(household_id, address, price, bedrooms, listing_url, image_url)"
        )
        # gte/lte on viewing_datetime also excludes NULL viewing_datetime rows.
        .gte("viewing_datetime", now.isoformat())
        .lte("viewing_datetime", window_end.isoformat())
        .is_("reminder_sent_at", "null")
        .order("viewing_datetime")
        .execute()
    )

    viewings = result.data or []

    if not viewings:
        print("No viewings need a reminder right now.")
        return 0

    print(
        f"Found {len(viewings)} viewing(s) within {REMINDER_WINDOW_HOURS}h "
        f"without a reminder."
    )
    failed = 0
    for viewing in viewings:
        property_data = viewing.get("properties") or {}
        address = property_data.get("address", "unknown property")
        when = viewing.get("viewing_datetime")
        household_id = property_data.get("household_id")

        # Claim the reminder before sending: if marking it failed after the
        # email went, every hourly run would send it again. Only the run
        # whose update finds it still unset goes on to send.
        try:
            claimed = (
                supabase.table("property_notes")
                .update({"reminder_sent_at": now.isoformat()})
                .eq("id", viewing["id"])
                .is_("reminder_sent_at", "null")
                .execute()
            ).data
        except Exception as error:
            print(f"Could not claim reminder for {address} @ {when}: {error}")
            failed += 1
            continue
        if not claimed:
            continue  # Another run already has it.

        try:
            # Every household, the original one included, is emailed at its
            # members' logins.
            recipients = member_emails(supabase, household_id)
            if not recipients:
                raise RuntimeError("no member emails for this household")
            send_viewing_reminder(viewing, recipients=recipients)
            print(f"Reminder sent and marked: {address} @ {when}")

        except Exception as error:
            # Release the claim so the next run retries.
            print(f"Failed to send reminder for {address} @ {when}: {error}")
            failed += 1
            try:
                supabase.table("property_notes").update(
                    {"reminder_sent_at": None}
                ).eq("id", viewing["id"]).execute()
            except Exception as release_error:
                print(f"Could not release reminder claim for {address} @ {when}: {release_error}")
            continue

        # Phone notification too. Best effort: the email already went and is
        # marked, so a push failure never causes a second reminder.
        try:
            pushed = send_to_household(
                supabase,
                household_id,
                title=f"Viewing: {address}",
                body=f"{format_viewing_datetime(when)}. Tap for the details.",
                url="/?view=calendar",
            )
            if pushed:
                print(f"Push sent to {pushed} phone(s).")
        except Exception as error:
            print(f"Push failed for {address} @ {when}: {error}")

    return failed


RUNSHEET_FROM_HOUR = 7  # London time
RUNSHEET_UNTIL_HOUR = 12
# The evening run-sheet for tomorrow goes on the first run in this window.
EVENING_FROM_HOUR = 18
EVENING_UNTIL_HOUR = 21
# "How was it?" goes this long after the viewing ends; older ones are left
# alone, so a job that was down for a day doesn't ask about last week.
FEEDBACK_AFTER_HOURS = 2
FEEDBACK_GIVE_UP_HOURS = 26


def _esc(value):
    return html.escape(str(value or ""))


def _parse(value):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _agent_push(user_id, title, body, url="/agent"):
    """Every phone the agent has the app on. Best effort: returns how many."""
    rows = (
        supabase.table("device_tokens").select("token").eq("user_id", user_id).execute().data or []
    )
    return send_to_tokens(supabase, [r["token"] for r in rows], title, body, url)


def _email_page(heading, inner):
    return f"""<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f8f6f2;font-family:Arial,sans-serif;color:#1f2937;">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4ddd2;border-radius:14px;padding:24px;">
<div style="font-size:11px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#b08d57;margin-bottom:8px;">ViewPal</div>
<h1 style="font-family:Georgia,serif;font-size:21px;color:#223a33;margin:0 0 12px;">{_esc(heading)}</h1>
{inner}
</div></body></html>"""


def _london_day_bounds(day):
    start = datetime.combine(day, datetime.min.time(), LONDON).astimezone(timezone.utc)
    return start, start + timedelta(days=1)


def _booked_by_agent(day):
    """{agent_id: [(slot, [confirmed bookings])]} for one London day."""
    day_start, day_end = _london_day_bounds(day)
    slots = (
        supabase.table("viewing_slots")
        .select(
            "id, agent_id, starts_at, ends_at, agent_listings(address), "
            "viewing_bookings(id, buyer_name, buyer_phone, buyer_email, status, created_at)"
        )
        .is_("cancelled_at", "null")
        .gte("starts_at", day_start.isoformat())
        .lt("starts_at", day_end.isoformat())
        .order("starts_at")
        .execute()
    ).data or []

    by_agent = {}
    for slot in slots:
        booked = [b for b in (slot.get("viewing_bookings") or []) if b.get("status") == "confirmed"]
        if booked:
            by_agent.setdefault(slot["agent_id"], []).append((slot, booked))
    return by_agent


def _runsheet_rows(items):
    """HTML table rows (time, address, buyer, phone) and the viewing count."""
    rows = []
    count = 0
    for slot, booked in items:
        start = _parse(slot["starts_at"]).astimezone(LONDON)
        address = (slot.get("agent_listings") or {}).get("address", "")
        for b in booked:
            count += 1
            phone = b.get("buyer_phone") or ""
            phone_html = (
                f'<a href="tel:{_esc(phone.replace(" ", ""))}" style="color:#223a33;">{_esc(phone)}</a>'
                if phone else ""
            )
            rows.append(
                f'<tr><td style="padding:8px 12px 8px 0;font-weight:bold;vertical-align:top;">{start:%H:%M}</td>'
                f'<td style="padding:8px 0;"><strong>{_esc(address)}</strong><br>'
                f'{_esc(b.get("buyer_name"))} {phone_html}</td></tr>'
            )
    return rows, count


def _plural(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


def send_agent_runsheets():
    """Each morning, email every agent the day's booked viewings in one list.

    Runs hourly with the reminders; sends once per agent per day (agents.
    runsheet_sent_on, migration 027) on the first run after 7am London.
    runsheet_sent_at (035) records when the bookings were read. Bookings made
    after that aren't pushed again here: the booking itself already sends the
    agent a "New viewing booked" push. viewing_bookings.agent_notified_late_at
    (035) is unused, kept reserved in case a late summary comes back.
    """
    london_now = datetime.now(LONDON)
    if not (RUNSHEET_FROM_HOUR <= london_now.hour < RUNSHEET_UNTIL_HOUR):
        return 0
    today = london_now.date()
    read_at = datetime.now(timezone.utc)
    by_agent = _booked_by_agent(today)
    if not by_agent:
        return 0

    agents = (
        supabase.table("agents")
        .select("user_id, name, email, runsheet_sent_on, runsheet_sent_at")
        .in_("user_id", list(by_agent))
        .execute()
    ).data or []

    failed = 0
    for agent in agents:
        if agent.get("runsheet_sent_on") == today.isoformat() or not agent.get("email"):
            continue
        rows, count = _runsheet_rows(by_agent[agent["user_id"]])
        first = (agent.get("name") or "").split(" ")[0]
        body = _email_page(
            "Today's viewings",
            f"""<p style="margin:0 0 12px;">Morning{(' ' + _esc(first)) if first else ''}. You have {_plural(count, 'viewing')} today:</p>
<table style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">{''.join(rows)}</table>
<p style="margin:0;color:#6b7280;font-size:13px;">Buyers can cancel up to the last minute; you'll get an email and a notification if they do.</p>""",
        )
        # Claim today's run-sheet before sending, so a failed mark can't
        # cause a second copy on the next hourly run.
        previous = {
            "runsheet_sent_on": agent.get("runsheet_sent_on"),
            "runsheet_sent_at": agent.get("runsheet_sent_at"),
        }
        try:
            claimed = (
                supabase.table("agents")
                .update({"runsheet_sent_on": today.isoformat(), "runsheet_sent_at": read_at.isoformat()})
                .eq("user_id", agent["user_id"])
                .or_(f"runsheet_sent_on.is.null,runsheet_sent_on.neq.{today.isoformat()}")
                .execute()
            ).data
        except Exception as error:
            print(f"Could not claim run-sheet for agent {agent['user_id'][:8]}: {error}")
            failed += 1
            continue
        if not claimed:
            continue  # Already sent today.
        try:
            send_resend_email(f"Today: {_plural(count, 'viewing')}", body, [agent["email"]])
            print(f"Run-sheet sent to agent {agent['user_id'][:8]} ({count} viewing(s)).")
        except Exception as error:
            print(f"Run-sheet failed for agent {agent['user_id'][:8]}: {error}")
            failed += 1
            # Release the claim so the next run (before noon) retries.
            try:
                supabase.table("agents").update(previous).eq("user_id", agent["user_id"]).execute()
            except Exception as release_error:
                print(f"Could not release run-sheet claim for agent {agent['user_id'][:8]}: {release_error}")
    return failed


def send_agent_evening_sheets():
    """Between 6pm and 9pm London, tell each agent tomorrow's viewings.

    One push and one email per agent per evening (agents.evening_sheet_sent_on
    = today's date, migration 035), only when they have bookings tomorrow.
    """
    london_now = datetime.now(LONDON)
    if not (EVENING_FROM_HOUR <= london_now.hour < EVENING_UNTIL_HOUR):
        return 0
    today = london_now.date()
    by_agent = _booked_by_agent(today + timedelta(days=1))
    if not by_agent:
        return 0

    agents = (
        supabase.table("agents")
        .select("user_id, name, email, evening_sheet_sent_on")
        .in_("user_id", list(by_agent))
        .execute()
    ).data or []

    failed = 0
    for agent in agents:
        if agent.get("evening_sheet_sent_on") == today.isoformat():
            continue
        items = by_agent[agent["user_id"]]
        rows, count = _runsheet_rows(items)
        first_slot = _parse(items[0][0]["starts_at"]).astimezone(LONDON)
        previous = agent.get("evening_sheet_sent_on")
        try:
            claimed = (
                supabase.table("agents")
                .update({"evening_sheet_sent_on": today.isoformat()})
                .eq("user_id", agent["user_id"])
                .or_(f"evening_sheet_sent_on.is.null,evening_sheet_sent_on.neq.{today.isoformat()}")
                .execute()
            ).data
        except Exception as error:
            print(f"Could not claim evening sheet for agent {agent['user_id'][:8]}: {error}")
            failed += 1
            continue
        if not claimed:
            continue  # Another run has it.

        title = f"Tomorrow: {_plural(count, 'viewing')}"
        emailed = email_failed = False
        if agent.get("email"):
            body = _email_page(
                "Tomorrow's viewings",
                f"""<p style="margin:0 0 12px;">You have {_plural(count, 'viewing')} tomorrow, the first at {first_slot:%H:%M}:</p>
<table style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">{''.join(rows)}</table>
<p style="margin:0;color:#6b7280;font-size:13px;">The final list comes in the morning, with anything booked overnight.</p>""",
            )
            try:
                send_resend_email(title, body, [agent["email"]])
                emailed = True
            except Exception as error:
                email_failed = True
                print(f"Evening sheet email failed for agent {agent['user_id'][:8]}: {error}")
        pushed = 0
        try:
            pushed = _agent_push(
                agent["user_id"], title, f"First at {first_slot:%H:%M}. Tap for the list.", "/agent?view=calendar"
            )
        except Exception as error:
            print(f"Evening sheet push failed for agent {agent['user_id'][:8]}: {error}")

        if emailed or pushed:
            print(f"Evening sheet sent to agent {agent['user_id'][:8]} ({count} viewing(s)).")
        elif email_failed:
            # Nothing reached them: release so the next run (before 9pm) retries.
            failed += 1
            try:
                supabase.table("agents").update({"evening_sheet_sent_on": previous}).eq(
                    "user_id", agent["user_id"]
                ).execute()
            except Exception as release_error:
                print(f"Could not release evening sheet claim for agent {agent['user_id'][:8]}: {release_error}")
    return failed


def ask_for_viewing_feedback():
    """About 2 hours after a viewing ends, ask the buyer "How was 12 Oak Road?".

    One push and one email per booking, linking to the Dashboard where the
    three one-tap answers are (migration 035). Claimed before sending
    (viewing_bookings.feedback_asked_at) so it's never asked twice; skipped
    if the household has already answered.
    """
    now = datetime.now(timezone.utc)
    rows = (
        supabase.table("viewing_bookings")
        .select(
            "id, buyer_id, property_id, "
            "viewing_slots!inner(starts_at, ends_at, cancelled_at, agent_listings(address))"
        )
        .eq("status", "confirmed")
        .is_("feedback_asked_at", "null")
        .not_.is_("buyer_id", "null")
        .not_.is_("property_id", "null")
        .is_("viewing_slots.cancelled_at", "null")
        .gte("viewing_slots.ends_at", (now - timedelta(hours=FEEDBACK_GIVE_UP_HOURS)).isoformat())
        .lte("viewing_slots.ends_at", (now - timedelta(hours=FEEDBACK_AFTER_HOURS)).isoformat())
        .execute()
    ).data or []

    failed = 0
    for booking in rows:
        slot = booking.get("viewing_slots") or {}
        address = (slot.get("agent_listings") or {}).get("address") or "your viewing"
        member = (
            supabase.table("household_members")
            .select("household_id")
            .eq("user_id", booking["buyer_id"])
            .limit(1)
            .execute()
        ).data or []
        if not member:
            continue
        household_id = member[0]["household_id"]

        try:
            claimed = (
                supabase.table("viewing_bookings")
                .update({"feedback_asked_at": now.isoformat()})
                .eq("id", booking["id"])
                .is_("feedback_asked_at", "null")
                .execute()
            ).data
        except Exception as error:
            print(f"Could not claim feedback ask for booking {booking['id'][:8]}: {error}")
            failed += 1
            continue
        if not claimed:
            continue  # Another run has it.

        # Answered already (e.g. in the app straight after): nothing to ask.
        starts = _parse(slot["starts_at"])
        answered = (
            supabase.table("viewing_feedback")
            .select("id")
            .eq("household_id", household_id)
            .eq("property_id", booking["property_id"])
            .gte("viewing_at", (starts - timedelta(hours=1)).isoformat())
            .lte("viewing_at", (starts + timedelta(hours=1)).isoformat())
            .execute()
        ).data
        if answered:
            continue

        link = f"{APP_URL.rstrip('/')}/?view=dashboard"
        title = f"How was {address}?"
        emailed = email_failed = False
        try:
            recipients = member_emails(supabase, household_id)
            if recipients:
                body = _email_page(
                    title,
                    f"""<p style="margin:0 0 16px;">One tap tells the agent how it went: <strong>Not for us</strong>, <strong>Maybe</strong> or <strong>Want a second look</strong>.</p>
<p style="margin:0 0 16px;"><a href="{_esc(link)}" style="background:#223a33;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">Say how it went</a></p>
<p style="margin:0;color:#6b7280;font-size:13px;">The agent sees your answer and any note, and the seller sees it without your name.</p>""",
                )
                send_resend_email(title, body, recipients)
                emailed = True
        except Exception as error:
            email_failed = True
            print(f"Feedback email failed for booking {booking['id'][:8]}: {error}")
        pushed = 0
        try:
            pushed = send_to_household(
                supabase,
                household_id,
                title=title,
                body="Not for us, maybe, or a second look? One tap.",
                url="/?view=dashboard",
            )
        except Exception as error:
            print(f"Feedback push failed for booking {booking['id'][:8]}: {error}")

        if emailed or pushed:
            print(f"Asked for feedback on booking {booking['id'][:8]}.")
        elif email_failed:
            # Nothing reached them: release so the next run tries again.
            failed += 1
            try:
                supabase.table("viewing_bookings").update({"feedback_asked_at": None}).eq(
                    "id", booking["id"]
                ).execute()
            except Exception as release_error:
                print(f"Could not release feedback claim for booking {booking['id'][:8]}: {release_error}")
    return failed


def mark_past_viewings_viewed():
    """Move homes from "Viewing booked" to "Viewed" once the viewing is over.

    Saves the buyer a tap; the Dashboard then asks how it went. Looks back a
    few days only, so a missed run catches up without rescanning history.
    """
    now = datetime.now(timezone.utc)
    result = (
        supabase
        .table("property_notes")
        .select("property_id, viewing_datetime, properties(status)")
        .gte("viewing_datetime", (now - timedelta(days=3)).isoformat())
        .lte("viewing_datetime", (now - timedelta(hours=1)).isoformat())
        .execute()
    )
    ids = [
        row["property_id"]
        for row in (result.data or [])
        if (row.get("properties") or {}).get("status") == "viewing_booked"
    ]
    if not ids:
        return
    (
        supabase.table("properties")
        .update({"status": "viewed"})
        .in_("id", ids)
        .eq("status", "viewing_booked")
        .execute()
    )
    print(f"Marked {len(ids)} home(s) as viewed.")


def roll_weekly_hours_forward():
    """Add the viewing times now due from every agent's weekly hours.

    Without this, times only roll forward when an agent opens the portal, so
    an agent away for a week leaves buyers with nothing to book.
    """
    supabase.rpc("sync_all_pattern_slots").execute()


if __name__ == "__main__":
    # Each step runs even if an earlier one fails, but any failure fails the
    # run, so GitHub emails about it instead of it going unnoticed. Steps that
    # send per item return how many items failed; those count too.
    failures = []
    for step in (
        roll_weekly_hours_forward,
        mark_past_viewings_viewed,
        send_agent_runsheets,
        send_agent_evening_sheets,
        run_viewing_reminders,
        ask_for_viewing_feedback,
    ):
        try:
            item_failures = step()
            if item_failures:
                failures.append(f"{step.__name__} ({item_failures} item(s))")
        except Exception as error:
            print(f"{step.__name__} failed: {error}")
            failures.append(step.__name__)
    if failures:
        sys.exit(f"Failed: {', '.join(failures)}")
