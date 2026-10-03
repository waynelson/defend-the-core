"""Build the add-on and install it on the mc-testing server through Crafty's
addon API, enabled, with a server restart.

    python tools/deploy.py            # build, upload, install, restart
    python tools/deploy.py --dry-run  # show what the install would do
"""

import json
import sys
import uuid

import build
import node


def upload(path) -> str:
    data = path.read_bytes()
    staged_id = uuid.uuid4().hex
    result = node.request(
        "post",
        "servers/{sid}/addons/upload",
        raw=data,
        content_type="application/octet-stream",
        headers={
            "fileId": staged_id,
            "fileName": path.name,
            "fileSize": str(len(data)),
            "totalChunks": "0",
        },
    )
    if not isinstance(result, dict) or result.get("status") not in ("ok", "completed"):
        sys.exit(f"upload failed: {result}")
    return staged_id


def main():
    dry_run = "--dry-run" in sys.argv
    package = build.main()
    staged_id = upload(package)
    report = node.request(
        "post",
        "servers/{sid}/addons",
        {
            "staged_id": staged_id,
            "enable": True,
            "allow_downgrade": True,
            "restart": not dry_run,
            "dry_run": dry_run,
        },
    )
    print(json.dumps(report, indent=2))
    if not isinstance(report, dict) or report.get("status") != "ok":
        sys.exit(1)


if __name__ == "__main__":
    main()
