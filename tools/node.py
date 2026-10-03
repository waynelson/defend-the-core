"""Talk to the mc-testing Crafty node using the hub's stored remote-node token.

    python tools/node.py get  servers/{sid}/stats
    python tools/node.py post servers/{sid}/files '{"page":"files","path":"x"}'

`{sid}` expands to the test server id.

Environment: CRAFTY_HUB_DB (hub sqlite path), DTC_NODE (remote node name),
DTC_SERVER (server id on that node).
"""

import json
import os
import sqlite3
import ssl
import sys
import urllib.request

HUB_DB = os.environ.get("CRAFTY_HUB_DB", r"C:\crafty\app\config\db\crafty.sqlite")
NODE_NAME = os.environ.get("DTC_NODE", "mc-testing")
SERVER_ID = os.environ.get("DTC_SERVER", "53b99c65-fc31-4c5e-9434-c806c4db0aa0")


def node():
    with sqlite3.connect(HUB_DB) as db:
        url, token = db.execute(
            "select url, api_token from remote_nodes where name = ?", (NODE_NAME,)
        ).fetchone()
    return url.rstrip("/") + "/api/v2", token


def request(method, path, body=None, raw=None, content_type="application/json",
            headers=None):
    base, token = node()
    # Git Bash rewrites "/x" args into Windows paths, so callers may omit the slash.
    path = "/" + path.lstrip("/").replace("{sid}", SERVER_ID)
    data = raw if raw is not None else (
        json.dumps(body).encode() if body is not None else None
    )
    req = urllib.request.Request(base + path, data=data, method=method.upper())
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", content_type)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    # The node uses a self-signed cert; the hub pins it, this dev tool doesn't.
    ctx = ssl._create_unverified_context()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
            text = resp.read().decode()
    except urllib.error.HTTPError as err:
        text = err.read().decode()
    try:
        return json.loads(text)
    except ValueError:
        return text


if __name__ == "__main__":
    method, path = sys.argv[1], sys.argv[2]
    body = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
    out = request(method, path, body)
    print(json.dumps(out, indent=2) if not isinstance(out, str) else out)
