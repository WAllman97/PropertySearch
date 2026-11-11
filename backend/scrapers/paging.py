import re


def with_query_param(url, key, value):
    """Return url with query parameter `key` set to `value`.

    Edits the raw query string rather than parsing/re-encoding it, so the
    sites' pre-encoded polygon parameters (some double-encoded) are left
    byte-for-byte intact."""
    base, _, fragment = url.partition("#")
    pattern = re.compile(rf'([?&]){re.escape(key)}=[^&]*')

    if pattern.search(base):
        base = pattern.sub(lambda m: f"{m.group(1)}{key}={value}", base, count=1)
    else:
        separator = "&" if "?" in base else "?"
        base = f"{base}{separator}{key}={value}"

    return f"{base}#{fragment}" if fragment else base
