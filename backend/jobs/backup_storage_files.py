"""Download every file in Supabase Storage, for the nightly backup.

    python backend/jobs/backup_storage_files.py <out dir>

Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Standard library only, so
the backup workflow doesn't have to install the backend's packages. Writes
<out dir>/<bucket>/<path> for each file and prints a count per bucket.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
HEADERS = {"Authorization": f"Bearer {KEY}", "apikey": KEY}


def call(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = dict(HEADERS, **({"Content-Type": "application/json"} if data else {}))
    request = urllib.request.Request(f"{URL}/storage/v1/{path}", data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def list_files(bucket, prefix=""):
    """Every file path in a bucket (folders are walked)."""
    files, offset = [], 0
    while True:
        page = json.loads(call(f"object/list/{bucket}", {
            "prefix": prefix, "limit": 1000, "offset": offset,
            "sortBy": {"column": "name", "order": "asc"},
        }))
        for entry in page:
            path = f"{prefix}{entry['name']}"
            if entry.get("id") is None:  # a folder
                files.extend(list_files(bucket, f"{path}/"))
            else:
                files.append(path)
        if len(page) < 1000:
            return files
        offset += 1000


def main(out_dir):
    buckets = json.loads(call("bucket"))
    total = 0
    for bucket in buckets:
        name = bucket["name"]
        paths = list_files(name)
        for path in paths:
            target = os.path.join(out_dir, name, *path.split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            quoted = urllib.parse.quote(path)
            with open(target, "wb") as handle:
                handle.write(call(f"object/{name}/{quoted}"))
        print(f"{name}: {len(paths)} file(s)")
        total += len(paths)
    os.makedirs(out_dir, exist_ok=True)
    print(f"Storage: {total} file(s) from {len(buckets)} bucket(s)")


if __name__ == "__main__":
    main(sys.argv[1])
