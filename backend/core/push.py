"""iPhone push notifications for scheduled jobs, sent straight to Apple (APNs).

Twin of frontend/api/_lib/push.js; same env vars:
  APNS_KEY      contents of the .p8 key (literal \\n allowed)
  APNS_KEY_ID   the key's 10-character Key ID
  APNS_TEAM_ID  your 10-character Apple Team ID
  APNS_BUNDLE_ID  optional, defaults to the app's bundle ID
Without them, sending is skipped and logged.
"""

import json
import os
import time

import httpx
import jwt

HOSTS = {
    "production": "https://api.push.apple.com",
    "sandbox": "https://api.sandbox.push.apple.com",
}


def _key():
    return (os.getenv("APNS_KEY") or "").replace("\\n", "\n").strip()


def push_configured():
    return bool(_key() and os.getenv("APNS_KEY_ID") and os.getenv("APNS_TEAM_ID"))


def _bundle_id():
    return os.getenv("APNS_BUNDLE_ID") or "com.wallman97.propertysearch"


_cached = {"token": None, "at": 0.0}


def provider_token(now=None):
    """ES256 JWT for APNs, reused for 40 minutes (Apple: refresh 20-60 min)."""
    now = now or time.time()
    if _cached["token"] and now - _cached["at"] < 40 * 60:
        return _cached["token"]
    token = jwt.encode(
        {"iss": os.getenv("APNS_TEAM_ID"), "iat": int(now)},
        _key(),
        algorithm="ES256",
        headers={"kid": os.getenv("APNS_KEY_ID")},
    )
    _cached.update(token=token, at=now)
    return token


def _post(client, host, device_token, body):
    try:
        response = client.post(
            f"{host}/3/device/{device_token}",
            content=body,
            headers={
                "authorization": f"bearer {provider_token()}",
                "apns-topic": _bundle_id(),
                "apns-push-type": "alert",
                "apns-priority": "10",
                "content-type": "application/json",
            },
        )
    except httpx.HTTPError as error:
        return 0, str(error)
    reason = ""
    if response.content:
        try:
            reason = response.json().get("reason", "")
        except ValueError:
            reason = response.text[:100]
    return response.status_code, reason


def send_to_tokens(supabase, tokens, title, body, url="/"):
    """Send one notification to each token. Tries production, falls back to
    sandbox for Xcode debug builds, and deletes tokens Apple says are dead.
    Returns the number delivered."""
    if not tokens:
        return 0
    if not push_configured():
        print(f"[push skipped: APNs not configured] {len(tokens)} phone(s): {title}")
        return 0

    payload = json.dumps(
        {"aps": {"alert": {"title": title, "body": body}, "sound": "default"}, "url": url}
    )
    sent = 0
    dead = []
    with httpx.Client(http2=True, timeout=10) as client:
        for token in tokens:
            status, reason = _post(client, HOSTS["production"], token, payload)
            if status == 400 and reason == "BadDeviceToken":
                status, reason = _post(client, HOSTS["sandbox"], token, payload)
            if status == 200:
                sent += 1
            elif status == 410 or reason in ("BadDeviceToken", "Unregistered"):
                dead.append(token)
            else:
                print(f"APNs refused a push ({status} {reason})")

    if dead:
        supabase.table("device_tokens").delete().in_("token", dead).execute()
    return sent


def send_to_household(supabase, household_id, title, body, url="/"):
    """Every phone belonging to a member of this household."""
    members = (
        supabase.table("household_members")
        .select("user_id")
        .eq("household_id", household_id)
        .execute()
        .data
        or []
    )
    user_ids = [m["user_id"] for m in members]
    if not user_ids:
        return 0
    rows = (
        supabase.table("device_tokens").select("token").in_("user_id", user_ids).execute().data
        or []
    )
    return send_to_tokens(supabase, [r["token"] for r in rows], title, body, url)
