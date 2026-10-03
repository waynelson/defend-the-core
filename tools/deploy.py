"""Build the add-on and install it through Crafty's addon API, enabled, with
a server restart.

    python tools/deploy.py                 # dev build to dev (mc-testing)
    python tools/deploy.py --dry-run       # show what the install would do
    DTC_TARGET=beta python tools/deploy.py --beta
                                           # tagged release build to beta (mc-defend)

Beta deploys need --beta as well as DTC_TARGET=beta, a clean working tree, and
HEAD tagged v<manifest version>, so beta only ever runs a published release.
"""

import json
import subprocess
import sys
import time
import uuid

import build
import node


def git(*args) -> str:
    return subprocess.run(
        ["git", *args], cwd=build.ROOT, capture_output=True, text=True, check=False
    ).stdout.strip()


def check_release():
    if node.TARGET != "beta" or "--beta" not in sys.argv:
        sys.exit("beta deploys need both DTC_TARGET=beta and --beta")
    if git("status", "--porcelain"):
        sys.exit("working tree is not clean; commit before a beta deploy")
    tag = "v" + ".".join(map(str, build.manifest_version()))
    if tag not in git("tag", "--points-at", "HEAD").split():
        sys.exit(f"HEAD is not tagged {tag}")


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


def started_at():
    stats = node.request("get", "servers/{sid}/stats")
    return stats["data"].get("started") if isinstance(stats, dict) else None


def wait_until_loaded(previous_start, timeout=240):
    """Wait for the restart to finish and the script to report `loaded`, then
    print any pack load errors."""
    import dm  # pylint: disable=import-outside-toplevel

    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(3)
        stats = node.request("get", "servers/{sid}/stats")
        data = stats.get("data", {}) if isinstance(stats, dict) else {}
        if not data.get("running") or data.get("started") == previous_start:
            continue
        lines = dm.console_lines()
        if any('"t":"loaded"' in line for line in lines):
            errors = [line for line in lines if "ERROR" in line]
            print("server up; script loaded" + (" with errors:" if errors else ""))
            for line in errors:
                print("  " + line[:240])
            # Chunks around the core keep loading for a few seconds more.
            time.sleep(5)
            return True
    print("timed out waiting for the server to come back")
    return False


def main():
    dry_run = "--dry-run" in sys.argv
    release = node.TARGET == "beta"
    if release:
        check_release()
    elif "--beta" in sys.argv:
        sys.exit("--beta needs DTC_TARGET=beta")
    print(f"target: {node.TARGET} ({node.NODE_NAME})")
    package = build.main(release=release)
    previous_start = started_at()
    staged_id = upload(package)
    report = node.request(
        "post",
        "servers/{sid}/addons",
        {
            "staged_id": staged_id,
            "enable": True,
            "allow_downgrade": not release,
            "restart": not dry_run,
            "dry_run": dry_run,
        },
    )
    if not isinstance(report, dict) or report.get("status") != "ok":
        print(json.dumps(report, indent=2))
        sys.exit(1)
    for pack in report["data"]["packs"]:
        print(f"  {pack['name']} {'.'.join(map(str, pack['version']))}: {pack['status']}")
    if report["data"].get("restarted") and not wait_until_loaded(previous_start):
        sys.exit(1)


if __name__ == "__main__":
    main()
